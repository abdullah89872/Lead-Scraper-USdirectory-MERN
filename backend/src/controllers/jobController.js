'use strict';

const { asyncHandler } = require('../middleware/validate');
const Job = require('../models/Job');
const { addJob, cancelJob, driver } = require('../queue');
const env = require('../config/env');
const logger = require('../config/logger');

const ACTIVE_STATUSES = ['queued', 'running'];

function ownedJobQuery(userId, jobId) {
  return Job.findOne({ _id: jobId, user: userId });
}

/** POST /api/jobs - queue a new scrape. */
const create = asyncHandler(async (req, res) => {
  const { source, category, location, maxLeads, enrichment, ai } = req.body;

  const job = await Job.create({
    user: req.user._id,
    source,
    category,
    location,
    maxLeads,
    enrichment,
    ai,
    mode: env.isMock ? 'mock' : 'live',
    status: 'queued',
    cancelRequested: false,
    progress: {
      stage: 'queued',
      percent: 0,
      message: 'Waiting for a worker',
      leadsFound: 0,
      updatedAt: new Date(),
    },
  });

  try {
    await addJob(job._id);
  } catch (error) {
    // The job record stays so the user can see *why* it never started.
    job.status = 'failed';
    job.error = `Could not queue the job: ${error.message}`;
    job.progress.stage = 'failed';
    job.progress.message = job.error;
    await job.save();
    logger.error({ jobId: String(job._id), err: error.message }, 'enqueue failed');
    return res.status(503).json({ error: job.error, job: job.toJSON() });
  }

  logger.info({ jobId: String(job._id), userId: String(req.user._id) }, 'job queued');
  return res.status(201).json({ job: job.toJSON() });
});

/** GET /api/jobs - paginated list, optionally filtered by status. */
const list = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const filter = { user: req.user._id };
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    Job.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Job.countDocuments(filter),
  ]);

  return res.json({
    jobs: items.map((job) => job.toJSON()),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

/** GET /api/jobs/:id */
const getOne = asyncHandler(async (req, res) => {
  const job = await ownedJobQuery(req.user._id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json({ job: job.toJSON() });
});

/** POST /api/jobs/:id/cancel - cooperative cancellation. */
const cancel = asyncHandler(async (req, res) => {
  const job = await ownedJobQuery(req.user._id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (!ACTIVE_STATUSES.includes(job.status)) {
    return res.status(409).json({
      error: `Job is already ${job.status} and cannot be cancelled`,
      job: job.toJSON(),
    });
  }

  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.completedAt = new Date();
    job.progress.stage = 'cancelled';
    job.progress.message = 'Cancelled before it started';
    job.progress.updatedAt = new Date();
  } else {
    job.progress.message = 'Cancellation requested - stopping at the next checkpoint';
  }
  await job.save();

  await cancelJob(job._id).catch((error) => {
    logger.warn({ jobId: String(job._id), err: error.message }, 'queue cancel failed');
  });

  return res.json({ job: job.toJSON() });
});

/** DELETE /api/jobs/:id */
const remove = asyncHandler(async (req, res) => {
  const job = await ownedJobQuery(req.user._id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (ACTIVE_STATUSES.includes(job.status)) {
    return res.status(409).json({ error: 'Cancel the job before deleting it' });
  }
  await job.deleteOne();
  return res.json({ deleted: true, id: req.params.id });
});

/** GET /api/jobs/meta/statuses - available filters for the UI. */
const statuses = asyncHandler(async (req, res) => {
  res.json({
    statuses: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    sources: [{ id: 'usdirectory', name: 'USdirectory.com' }],
    queueDriver: driver(),
  });
});

module.exports = { cancel, create, getOne, list, remove, statuses };