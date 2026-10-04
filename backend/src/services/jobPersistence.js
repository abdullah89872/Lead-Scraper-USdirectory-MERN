'use strict';

/**
 * Job runner - the orchestration core.
 *
 *   scrape -> normalize -> deduplicate -> (AI) -> persist -> finalize
 *
 * It is queue agnostic: BullMQ workers and the inline queue both call
 * `runJob(jobId)`. Cancellation is cooperative (checked between stages), so it
 * works identically for both drivers.
 */

const Job = require('../models/Job');
const Lead = require('../models/Lead');
const env = require('../config/env');
const logger = require('../config/logger');
const aiService = require('./aiService');
const { dedupeKeys, dedupeLeads, mergeLeadInto } = require('./dedupe');
const mockScraper = require('./mockScraper');
const { normalizeLead } = require('./normalize');
const scraperClient = require('./scraperClient');

const PROGRESS_THROTTLE_MS = 350;

function publicApiUrl() {
  return (process.env.PUBLIC_API_URL || `http://127.0.0.1:${env.port}`).replace(/\/+$/, '');
}

async function isCancelled(jobId) {
  const current = await Job.findById(jobId).select('status cancelRequested').lean();
  return !current || current.status === 'cancelled' || current.cancelRequested;
}

async function finalizeCancelled(job) {
  job.status = 'cancelled';
  job.completedAt = new Date();
  job.progress.stage = 'cancelled';
  job.progress.message = 'Cancelled by user';
  await job.save();
  logger.info({ jobId: String(job._id) }, 'job cancelled');
}

/**
 * Persist leads, merging exact duplicates into existing records instead of
 * creating copies. Uncertain matches are kept and flagged.
 */
async function persistLeads({ job, leads }) {
  const userId = job.user;
  const urls = leads.map((lead) => lead.sourceUrl).filter(Boolean);
  const emails = leads.flatMap((lead) => lead.publicEmails || []).filter(Boolean);
  const phones = leads.flatMap((lead) => lead.publicPhones || []).filter(Boolean);

  const or = [];
  if (urls.length) or.push({ sourceUrl: { $in: urls } });
  if (emails.length) or.push({ email: { $in: emails } });
  if (phones.length) or.push({ phone: { $in: phones } });

  const existing = or.length ? await Lead.find({ user: userId, $or: or }).limit(5000) : [];

  const index = new Map();
  existing.forEach((doc) => {
    dedupeKeys(doc).forEach((key) => {
      if (!index.has(key)) index.set(key, doc);
    });
  });

  const touched = new Map();
  let created = 0;
  let merged = 0;

  leads.forEach((lead) => {
    const match = dedupeKeys(lead)
      .map((key) => index.get(key))
      .find(Boolean);

    if (match) {
      mergeLeadInto(match, lead);
      match.enrichmentStatus = match.enrichmentStatus || lead.enrichmentStatus;
      if (!match.job) match.job = job._id;
      touched.set(match.id, match);
      merged += 1;
      dedupeKeys(match).forEach((key) => index.set(key, match));
      return;
    }

    const doc = new Lead({ ...lead, user: userId, job: job._id });
    touched.set(doc.id, doc);
    created += 1;
    dedupeKeys(doc).forEach((key) => index.set(key, doc));
  });

  const docs = Array.from(touched.values());
  await Promise.all(
    docs.map((doc) =>
      doc.save().catch((error) => {
        logger.warn({ err: error.message, lead: doc.businessName }, 'failed to save lead');
        return null;
      })
    )
  );

  return { created, merged, docs };
}

module.exports = {
  PROGRESS_THROTTLE_MS,
  finalizeCancelled,
  isCancelled,
  persistLeads,
  publicApiUrl,
};
