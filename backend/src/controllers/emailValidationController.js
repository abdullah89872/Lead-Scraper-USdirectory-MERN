'use strict';

/**
 * Email Validation Controller
 *
 * POST /api/validate/emails
 *
 * Body:  { emails: "a@test.com, b@other.com\n...or" }
 *        OR      { emails: [{ email: "..." }, ...] }
 * Output: { results: [{ email, status, flags, reason }],
 *           summary: { total, valid, invalid, risky, duplicates } }
 *
 * status:   'valid' | 'invalid' | 'warning' | 'duplicate'
 * flags:    ['syntax'] | ['mx'] | ['disposable'] | ['role'] | ['duplicate']
 */

const { asyncHandler } = require('../middleware/validate');
const fs = require('fs');
const pipeline = require('../services/validation/pipeline');
const orchestrator = require('../services/validation/orchestrator');
const csvService = require('../services/validation/csv');
const lists = require('../services/validation/lists');
const ValidationJob = require('../models/ValidationJob');
const Lead = require('../models/Lead');
const env = require('../config/env');
const logger = require('../config/logger');

const MAX_EMAILS_PER_REQUEST = env.validation.maxEmailsPerRequest;

function normaliseEmails(body) {
  const raw = body && body.emails;
  if (typeof raw === 'string') return raw.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === 'string' ? item : String(item?.email || '')).trim()).filter(Boolean);
  }
  return [];
}

/**
 * POST /api/validate/email-list
 * Queue email-list validation so SMTP checks cannot hold the HTTP request open.
 */
const validateEmailList = asyncHandler(async (req, res) => {
  const emails = normaliseEmails(req.body);
  if (!emails.length) {
    return res.status(400).json({ error: 'Email list is required' });
  }
  if (emails.length > MAX_EMAILS_PER_REQUEST) {
    return res.status(400).json({
      error: 'Too many emails to validate',
      details: [{ message: `Maximum ${MAX_EMAILS_PER_REQUEST} emails per request.` }],
    });
  }

  const userId = req.user._id;
  const activeCount = await ValidationJob.countDocuments({
    user: userId,
    status: { $in: ['queued', 'running'] },
  });
  if (activeCount >= env.validation.maxActiveJobsPerUser) {
    return res.status(409).json({
      error: 'Too many active validation jobs',
      details: [{ message: `Maximum ${env.validation.maxActiveJobsPerUser} concurrent validation jobs per user.` }],
    });
  }

  const job = await ValidationJob.create({
    user: userId,
    kind: 'email-list',
    inputEmails: emails,
    options: {
      batchSize: env.validation.batchSize,
      concurrency: env.validation.concurrency,
    },
    status: 'queued',
    progress: { stage: 'queued', percent: 0, message: 'Queued', total: emails.length, processed: 0 },
    summary: { total: emails.length },
  });

  processValidationJob(job._id).catch((error) => {
    logger.error({ jobId: String(job._id), err: error.message }, 'email-list validation job failed');
  });

  return res.status(202).json({ job: job.toJSON() });
});

/**
 * POST /api/validate/leads
 * Kick off a background validation job for leads matching a filter or id list.
 */
const validateLeads = asyncHandler(async (req, res) => {
  const { leadIds, filter, options } = req.body || {};
  const userId = req.user._id;

  const activeCount = await ValidationJob.countDocuments({
    user: userId,
    status: { $in: ['queued', 'running'] },
  });
  if (activeCount >= env.validation.maxActiveJobsPerUser) {
    return res.status(409).json({
      error: 'Too many active validation jobs',
      details: [{ message: `Maximum ${env.validation.maxActiveJobsPerUser} concurrent validation jobs per user.` }],
    });
  }

  const job = await ValidationJob.create({
    user: userId,
    kind: 'leads',
    leadIds: leadIds && leadIds.length ? leadIds.map((id) => String(id)) : [],
    leadFilter: filter || {},
    options: {
      batchSize: options?.batchSize ?? env.validation.batchSize,
      concurrency: options?.concurrency ?? env.validation.concurrency,
    },
    status: 'queued',
    progress: { stage: 'queued', percent: 0, message: 'Queued', total: 0, processed: 0 },
  });

  processValidationJob(job._id).catch((error) => {
    logger.error({ jobId: String(job._id), err: error.message }, 'validation job failed');
  });

  return res.status(201).json({ job: job.toJSON() });
});

/**
 * POST /api/validate/csv
 * Validate an uploaded CSV file.
 */
const validateCsv = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file is required (field name: file)' });
  }

  let parsed;
  try {
    parsed = csvService.parseUploadCsv(req.file.path);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid CSV file', details: [{ message: error.message }] });
  }

  if (!parsed.emailColumn) {
    return res.status(400).json({
      error: 'No email column detected',
      details: [{ message: 'Could not find an email column in the CSV.' }],
    });
  }

  const userId = req.user._id;

  const activeCount = await ValidationJob.countDocuments({
    user: userId,
    status: { $in: ['queued', 'running'] },
  });
  if (activeCount >= env.validation.maxActiveJobsPerUser) {
    return res.status(409).json({
      error: 'Too many active validation jobs',
      details: [{ message: `Maximum ${env.validation.maxActiveJobsPerUser} concurrent validation jobs per user.` }],
    });
  }

  const job = await ValidationJob.create({
    user: userId,
    kind: 'csv',
    emailColumn: parsed.emailColumn,
    sourceFileName: req.file.originalname,
    inputFile: req.file.path,
    options: {
      batchSize: env.validation.batchSize,
      concurrency: env.validation.concurrency,
    },
    status: 'queued',
    progress: { stage: 'queued', percent: 0, message: 'Queued', total: parsed.rowCount, processed: 0 },
  });

  processValidationJob(job._id).catch((error) => {
    logger.error({ jobId: String(job._id), err: error.message }, 'validation job failed');
  });

  return res.status(201).json({ job: job.toJSON(), emailColumn: parsed.emailColumn, rowCount: parsed.rowCount });
});

/**
 * GET /api/validate/jobs
 */
const listValidationJobs = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const kind = req.query.kind;
  const status = req.query.status;

  const filter = { user: req.user._id };
  if (kind) filter.kind = kind;
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    ValidationJob.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-inputFile -inputEmails -results'),
    ValidationJob.countDocuments(filter),
  ]);

  return res.json({
    jobs: items.map((j) => j.toJSON()),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

/**
 * GET /api/validate/jobs/:id
 */
const getValidationJob = asyncHandler(async (req, res) => {
  const job = await ValidationJob.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select('-inputFile -inputEmails');
  if (!job) return res.status(404).json({ error: 'Validation job not found' });
  return res.json({ job: job.toJSON() });
});

/**
 * GET /api/validate/jobs/:id/results
 */
const getValidationResults = asyncHandler(async (req, res) => {
  const job = await ValidationJob.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!job) return res.status(404).json({ error: 'Validation job not found' });

  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const statusFilter = req.query.status;

  let results;
  let total;

  if (job.kind === 'csv' || job.kind === 'email-list') {
    const all = Array.isArray(job.results) ? job.results : [];
    let filtered = all;
    if (statusFilter) filtered = all.filter((r) => r.status === statusFilter);
    total = filtered.length;
    results = filtered.slice((page - 1) * limit, page * limit);
  } else {
    const leadFilter = { user: req.user._id };
    if (job.leadIds && job.leadIds.length) leadFilter._id = { $in: job.leadIds };
    if (Object.keys(job.leadFilter || {}).length) Object.assign(leadFilter, job.leadFilter);
    if (statusFilter) leadFilter.emailStatus = statusFilter.toLowerCase();

    const [items, count] = await Promise.all([
      Lead.find(leadFilter)
        .select('email businessName emailStatus emailValidation createdAt')
        .skip((page - 1) * limit)
        .limit(limit),
      Lead.countDocuments(leadFilter),
    ]);
    total = count;
    results = items.map((lead) => {
      const ev = lead.emailValidation || {};
      return {
        raw: lead.email,
        address: lead.email,
        status: lead.emailStatus || ev.status || 'UNKNOWN',
        confidence: ev.confidence || 0,
        reason: ev.reason || null,
        syntaxValid: ev.syntaxValid,
        domainExists: ev.domainExists,
        mxFound: ev.mxFound,
        disposable: ev.disposable,
        roleBased: ev.roleBased,
        freeProvider: ev.freeProvider,
        smtpAttempted: ev.smtpAttempted,
        smtpResult: ev.smtpResult,
        catchAll: ev.catchAllSuspected,
        leadId: lead._id,
        businessName: lead.businessName,
        validatedAt: ev.validatedAt,
      };
    });
  }

  return res.json({
    jobId: job._id,
    results,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    summary: job.summary || {},
  });
});

/**
 * POST /api/validate/jobs/:id/cancel
 */
const cancelValidationJob = asyncHandler(async (req, res) => {
  const job = await ValidationJob.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!job) return res.status(404).json({ error: 'Validation job not found' });

  if (!['queued', 'running'].includes(job.status)) {
    return res.status(409).json({ error: `Job is ${job.status} and cannot be cancelled` });
  }

  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.completedAt = new Date();
    job.progress.stage = 'cancelled';
    job.progress.message = 'Cancelled before it started';
  } else {
    job.progress.message = 'Cancellation requested - stopping at the next checkpoint';
  }
  job.progress.updatedAt = new Date();
  await job.save();

  return res.json({ job: job.toJSON() });
});

/**
 * GET /api/validate/jobs/:id/export/csv
 */
const exportValidationCsv = asyncHandler(async (req, res) => {
  const job = await ValidationJob.findOne({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!job) return res.status(404).json({ error: 'Validation job not found' });

  let results;
  if (job.kind !== 'leads') {
    results = Array.isArray(job.results) ? job.results : [];
  } else {
    const leadFilter = { user: req.user._id };
    if (job.leadIds && job.leadIds.length) leadFilter._id = { $in: job.leadIds };
    if (Object.keys(job.leadFilter || {}).length) Object.assign(leadFilter, job.leadFilter);

    const leads = await Lead.find(leadFilter).select('email businessName emailValidation emailStatus').lean();
    results = leads.map((lead) => {
      const ev = lead.emailValidation || {};
      return {
        raw: lead.email,
        address: lead.email,
        status: lead.emailStatus || ev.status || 'UNKNOWN',
        confidence: ev.confidence || 0,
        reason: ev.reason || null,
        syntaxValid: ev.syntaxValid,
        domainExists: ev.domainExists,
        mxFound: ev.mxFound,
        disposable: ev.disposable,
        roleBased: ev.roleBased,
        freeProvider: ev.freeProvider,
        smtpAttempted: ev.smtpAttempted,
        smtpResult: ev.smtpResult,
        catchAll: ev.catchAllSuspected,
        leadId: lead._id,
        firstName: lead.businessName,
        validatedAt: ev.validatedAt,
      };
    });
  }

  const buffer = csvService.exportResultsCsv(results, { includeLeadMeta: true });
  const fileName = `validation-${job.kind}-${job._id}-${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * GET /api/validate/jobs/:id/export/valid-leads.csv
 * Download the original uploaded CSV rows whose email passed validation.
 */
const exportValidCsvLeads = asyncHandler(async (req, res) => {
  const job = await ValidationJob.findOne({
    _id: req.params.id,
    user: req.user._id,
  }).select('+inputFile');
  if (!job) return res.status(404).json({ error: 'Validation job not found' });
  if (job.kind !== 'csv') {
    return res.status(400).json({ error: 'Valid-lead CSV export is only available for CSV validation jobs' });
  }
  if (job.status !== 'completed') {
    return res.status(409).json({ error: 'Wait for CSV validation to complete before exporting valid leads' });
  }
  if (!job.inputFile || !fs.existsSync(job.inputFile)) {
    return res.status(410).json({ error: 'The original CSV file is no longer available for export' });
  }

  const parsed = csvService.parseUploadCsv(job.inputFile);
  const validRows = new Set(
    (Array.isArray(job.results) ? job.results : [])
      .filter((result) => result.status === pipeline.STATUS_VALID)
      .map((result) => result.rowIndex)
  );
  const rows = parsed.rows.filter((row) => validRows.has(row.rowIndex));
  const buffer = Buffer.from(`\uFEFF${csvService.buildCsvText(rows, parsed.headers)}`, 'utf8');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="valid-leads-${job._id}-${Date.now()}.csv"`
  );
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
});

/**
 * GET /api/validate/settings
 */
const getValidationSettings = asyncHandler(async (_req, res) => {
  return res.json({
    validation: {
      auto: env.validation.auto,
      validPolicy: env.validation.validPolicy,
      roleAsRisky: env.validation.roleAsRisky,
      batchSize: env.validation.batchSize,
      concurrency: env.validation.concurrency,
      maxEmailsPerRequest: env.validation.maxEmailsPerRequest,
      smtp: {
        enabled: env.validation.smtp.enabled,
        timeoutMs: env.validation.smtp.timeoutMs,
        maxConcurrency: env.validation.smtp.maxConcurrency,
        requireTls: env.validation.smtp.requireTls,
        respectServerLimits: env.validation.smtp.respectServerLimits,
        stopOnProviderRestriction: env.validation.smtp.stopOnProviderRestriction,
      },
      dns: {
        timeoutMs: env.validation.dns.timeoutMs,
        cacheTtlMs: env.validation.dns.cacheTtlMs,
        negativeCacheTtlMs: env.validation.dns.negativeCacheTtlMs,
      },
      statuses: [
        pipeline.STATUS_VALID,
        pipeline.STATUS_INVALID,
        pipeline.STATUS_RISKY,
        pipeline.STATUS_UNKNOWN,
        pipeline.STATUS_PENDING,
        pipeline.STATUS_ERROR,
      ],
    },
    lists: lists.listInfo(),
  });
});

/**
 * Background processor for a ValidationJob.
 */
async function processValidationJob(jobId) {
  const job = await ValidationJob.findById(jobId).select('+inputFile +inputEmails');
  if (!job) throw new Error(`Validation job ${jobId} not found`);

  const isCancelled = () => job.cancelRequested || job.status === 'cancelled';

  try {
    job.status = 'running';
    job.startedAt = new Date();
    job.progress.stage = 'running';
    job.progress.message = 'Validating addresses';
    await job.save();

    let addresses = [];
    let csvAddressRows = [];
    let leadDocs = [];

    if (job.kind === 'email-list') {
      addresses = job.inputEmails || [];
    } else if (job.kind === 'csv') {
      const parsed = csvService.parseUploadCsv(job.inputFile);
      csvAddressRows = parsed.rows
        .map((row) => ({
          rowIndex: row.rowIndex,
          email: String(row[job.emailColumn] || '').trim(),
        }))
        .filter((row) => row.email);
      addresses = csvAddressRows.map((row) => row.email);
    } else {
      const query = job.leadIds && job.leadIds.length
        ? { _id: { $in: job.leadIds } }
        : job.leadFilter || {};
      leadDocs = await Lead.find(query).select('email _id').lean();
      addresses = leadDocs.map((ld) => ld.email).filter(Boolean);
    }

    job.progress.total = addresses.length;
    job.summary.total = addresses.length;
    await job.save();

    if (addresses.length === 0) {
      job.status = 'completed';
      job.completedAt = new Date();
      job.progress.stage = 'completed';
      job.progress.percent = 100;
      job.progress.message = 'No addresses to validate';
      await job.save();
      return job;
    }

    await orchestrator.warmDnsCache(addresses);

    const sharedSession = require('../services/validation/smtp').createSession();

    let processed = 0;
    const results = [];
    const batchSize = job.options.batchSize || env.validation.batchSize;
    const concurrency = job.options.concurrency || env.validation.concurrency;

    for (let i = 0; i < addresses.length; i += batchSize) {
      if (isCancelled()) {
        job.status = 'cancelled';
        job.completedAt = new Date();
        job.progress.stage = 'cancelled';
        job.progress.message = 'Cancelled by user';
        job.progress.updatedAt = new Date();
        job.summary = pipeline.summaryOf(results);
        await job.save();
        return job;
      }

      const batch = addresses.slice(i, i + batchSize);
      const batchResults = new Array(batch.length);
      await orchestrator.processConcurrent(batch, {
        concurrency,
        sharedSession,
        onAddressResult: (result, batchIndex) => {
          batchResults[batchIndex] = job.kind === 'csv'
            ? { ...result, rowIndex: csvAddressRows[i + batchIndex].rowIndex }
            : result;
          processed += 1;
        },
        isCancelled,
      });
      results.push(...batchResults.filter(Boolean));

      const percent = Math.round((processed / addresses.length) * 100);
      job.progress.processed = processed;
      job.progress.percent = percent;
      job.progress.stage = `validating (${processed}/${addresses.length})`;
      job.progress.updatedAt = new Date();
      job.summary = pipeline.summaryOf(results);
      await job.save();
    }

    if (isCancelled()) {
      job.status = 'cancelled';
      job.completedAt = new Date();
      job.progress.stage = 'cancelled';
      job.progress.message = 'Cancelled by user';
      job.progress.updatedAt = new Date();
      job.summary = pipeline.summaryOf(results);
      await job.save();
      return job;
    }

    if (job.kind !== 'leads') {
      job.results = results;
    }

    if (job.kind === 'leads' && leadDocs.length) {
      const leadByEmail = new Map();
      leadDocs.forEach((ld) => leadByEmail.set(String(ld.email).toLowerCase(), ld._id));

      const leadUpdates = results
        .filter((r) => r.address)
        .map((r) => {
          const leadId = leadByEmail.get(String(r.address).toLowerCase());
          if (!leadId) return null;
          const ev = {
            status: r.status,
            confidence: r.confidence,
            syntaxValid: r.syntaxValid,
            domainExists: r.domainExists,
            mxFound: r.mxFound,
            mxFallbackUsed: r.fallbackUsed,
            disposable: r.disposable,
            roleBased: r.roleBased,
            freeProvider: r.freeProvider,
            catchAllSuspected: r.catchAll,
            smtpAttempted: r.smtpAttempted,
            smtpResult: r.smtpResult,
            smtpCode: r.smtpCode,
            reason: r.reason,
            validatedAt: new Date(),
          };
          return Lead.updateOne(
            { _id: leadId, user: job.user },
            { $set: { emailStatus: r.status.toLowerCase(), emailValidation: ev } }
          );
        })
        .filter(Boolean);

      await Promise.all(leadUpdates);
    }

    job.status = 'completed';
    job.completedAt = new Date();
    job.progress.stage = 'completed';
    job.progress.percent = 100;
    job.progress.processed = processed;
    job.progress.message = `Validated ${processed} address${processed !== 1 ? 'es' : ''}`;
    job.progress.updatedAt = new Date();
    job.summary = pipeline.summaryOf(results);
    await job.save();

    logger.info(
      { jobId: String(job._id), kind: job.kind, processed, summary: job.summary },
      'validation job completed'
    );
    return job;
  } catch (error) {
    logger.error({ jobId: String(jobId), err: error.message }, 'validation job error');
    job.status = 'failed';
    job.completedAt = new Date();
    job.error = error.message;
    job.progress.stage = 'failed';
    job.progress.message = error.message;
    job.progress.updatedAt = new Date();
    await job.save();
    throw error;
  }
}

module.exports = {
  validateEmailList,
  validateLeads,
  validateCsv,
  listValidationJobs,
  getValidationJob,
  getValidationResults,
  cancelValidationJob,
  exportValidationCsv,
  exportValidCsvLeads,
  getValidationSettings,
  processValidationJob,
};