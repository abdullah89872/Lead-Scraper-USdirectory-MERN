'use strict';

/**
 * Job runner - the orchestration core.
 *
 *   scrape -> normalize -> deduplicate -> (optional AI) -> persist -> finalize
 *
 * The runner is queue agnostic: BullMQ workers and the inline queue both call
 * `runJob(jobId)`. Cancellation is cooperative (checked between stages) so it
 * behaves the same on both drivers, and progress is written to MongoDB where
 * the SSE endpoint picks it up.
 */

const Job = require('../models/Job');
const ValidationJob = require('../models/ValidationJob');
const env = require('../config/env');
const logger = require('../config/logger');
const aiService = require('./aiService');
const { dedupeLeads } = require('./dedupe');
const {
  PROGRESS_THROTTLE_MS,
  finalizeCancelled,
  isCancelled,
  persistLeads,
  publicApiUrl,
} = require('./jobPersistence');
const mockScraper = require('./mockScraper');
const { normalizeLead } = require('./normalize');
const scraperClient = require('./scraperClient');
const { processValidationJob } = require('../controllers/emailValidationController');

/**
 * Execute one scrape job.
 * @param {string|import('mongoose').Types.ObjectId} jobId
 */
async function runJob(jobId) {
  const job = await Job.findById(jobId);
  if (!job) {
    logger.warn({ jobId: String(jobId) }, 'job not found, skipping');
    return null;
  }
  if (job.status === 'cancelled' || job.cancelRequested) {
    await finalizeCancelled(job);
    return job;
  }

  job.status = 'running';
  job.startedAt = new Date();
  job.error = null;
  job.progress.stage = 'searching';
  job.progress.percent = 2;
  job.progress.message = 'Starting scrape';
  job.progress.updatedAt = new Date();
  await job.save();

  let lastWrite = 0;
  const reportProgress = async (update) => {
    const now = Date.now();
    const isTerminal = update.stage === 'done';
    if (!isTerminal && now - lastWrite < PROGRESS_THROTTLE_MS) return;
    lastWrite = now;
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          'progress.stage': update.stage || 'running',
          'progress.percent': Math.max(0, Math.min(100, update.percent ?? 0)),
          'progress.message': update.message || null,
          'progress.leadsFound': update.leadsFound ?? 0,
          'progress.updatedAt': new Date(),
        },
      }
    );
  };

  const useMock = env.isMock || job.mode === 'mock';
  let scrapeResult;

  try {
    if (useMock) {
      scrapeResult = await mockScraper.scrape({
        category: job.category,
        location: job.location,
        maxLeads: job.maxLeads,
        enrichment: job.enrichment,
        onProgress: reportProgress,
      });
    } else {
      scrapeResult = await scraperClient.scrape({
        category: job.category,
        location: job.location,
        maxLeads: job.maxLeads,
        source: job.source,
        enrichment: job.enrichment,
        ai: job.ai,
        jobId: String(job._id),
        progressUrl: `${publicApiUrl()}/api/internal/jobs/${job._id}/progress`,
        progressToken: env.internalApiToken,
      });
    }
  } catch (error) {
    if (await isCancelled(job._id)) return finalizeCancelled(job);
    job.status = 'failed';
    job.completedAt = new Date();
    job.error = error.message;
    job.progress.stage = 'failed';
    job.progress.message = error.message;
    await job.save();
    logger.error({ jobId: String(job._id), err: error.message }, 'job failed');
    return job;
  }

  if (await isCancelled(job._id)) return finalizeCancelled(job);

  return finalizeSuccessfulJob(job, scrapeResult, reportProgress);
}

/** Normalize, dedupe, optionally AI-process and store the scraped leads. */
async function finalizeSuccessfulJob(job, scrapeResult, reportProgress) {
  await reportProgress({ stage: 'normalizing', percent: 88, message: 'Normalizing results' });

  const rawLeads = Array.isArray(scrapeResult?.leads) ? scrapeResult.leads : [];
  const normalized = rawLeads
    .map((lead) => normalizeLead(lead))
    .filter((lead) => lead.businessName && lead.sourceUrl);

  const batch = dedupeLeads(normalized);
  const persisted = await persistLeads({ job, leads: batch.leads });

  let aiStats = { processed: 0, failed: 0 };
  if (job.ai && aiService.isEnabled()) {
    await reportProgress({ stage: 'ai', percent: 94, message: 'Running AI categorization' });
    aiStats = await aiService.enrichLeads(persisted.docs);
    await Promise.all(persisted.docs.map((doc) => doc.save().catch(() => null)));
  }

  const blocked = Boolean(scrapeResult?.stats?.blocked);
  const warnings = [...(scrapeResult?.warnings || [])];
  if (blocked && persisted.docs.length === 0) {
    warnings.push(
      'The source restricted automated access. The run stopped without attempting to bypass it.'
    );
  }

  job.status = 'completed';
  job.completedAt = new Date();
  job.leadsCount = persisted.docs.length;
  job.duplicatesMerged = batch.removed + persisted.merged;
  job.possibleDuplicates = batch.possibleDuplicates;
  job.warnings = warnings;
  job.stats = {
    ...(scrapeResult?.stats || {}),
    requested: job.maxLeads,
    scraped: normalized.length,
    created: persisted.created,
    merged: persisted.merged,
    removedInBatch: batch.removed,
    possibleDuplicates: batch.possibleDuplicates,
    aiProcessed: aiStats.processed,
    aiFailed: aiStats.failed,
    durationMs: job.startedAt ? Date.now() - job.startedAt.getTime() : null,
  };
  job.progress.stage = 'completed';
  job.progress.percent = 100;
  job.progress.message = `${persisted.docs.length} leads saved`;
  job.progress.leadsFound = persisted.docs.length;
  job.progress.updatedAt = new Date();
  if (!job.error) job.error = null;
  await job.save();

  // ---- Auto-validation (fire-and-forget) ----------------------------------
  if (env.validation.auto && persisted.docs.length) {
    const leadIds = persisted.docs
      .map((doc) => doc._id)
      .filter((id) => id)
      .map((id) => String(id));

    if (leadIds.length) {
      ValidationJob.create({
        user: job.user,
        kind: 'leads',
        leadIds,
        leadFilter: {},
        options: {
          batchSize: env.validation.batchSize,
          concurrency: env.validation.concurrency,
        },
        status: 'queued',
        progress: { stage: 'queued', percent: 0, message: 'Auto-queued after scrape', total: 0, processed: 0 },
      })
        .then((vjob) => processValidationJob(vjob._id).catch((err) => {
          logger.error({ jobId: String(vjob._id), err: err.message }, 'auto-validation job failed');
        }))
        .catch((err) => {
          logger.error({ jobId: String(job._id), err: err.message }, 'auto-validation job creation failed');
        });
    }
  }

  logger.info(
    {
      jobId: String(job._id),
      leads: persisted.docs.length,
      created: persisted.created,
      merged: persisted.merged,
    },
    'job completed'
  );
  return job;
}

module.exports = { finalizeSuccessfulJob, runJob };
