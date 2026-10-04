'use strict';

/**
 * Internal progress webhook.
 *
 * In live mode the Python scraper POSTs progress here instead of holding the
 * HTTP connection open for minutes. It is guarded by the shared internal token
 * and is **not** part of the public API.
 */

const Job = require('../models/Job');
const logger = require('../config/logger');
const { PROGRESS_THROTTLE_MS } = require('../services/jobPersistence');

const lastWrite = new Map();

/** POST /api/internal/jobs/:id/progress */
async function report(req, res) {
  const { stage, percent, message, leadsFound } = req.body;

  const key = req.params.id;
  const now = Date.now();
  const previous = lastWrite.get(key) || 0;
  const isTerminal = stage === 'done' || percent >= 100;
  // Throttle so a chatty scrape does not hammer MongoDB.
  if (!isTerminal && now - previous < PROGRESS_THROTTLE_MS) {
    return res.status(202).json({ accepted: true, throttled: true });
  }
  lastWrite.set(key, now);

  const job = await Job.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        'progress.stage': stage || 'running',
        'progress.percent': Math.max(0, Math.min(100, Number(percent) || 0)),
        'progress.message': message || null,
        'progress.leadsFound': Number(leadsFound) || 0,
        'progress.updatedAt': new Date(),
      },
    },
    { new: true }
  );

  if (!job) {
    lastWrite.delete(key);
    return res.status(404).json({ error: 'Job not found' });
  }

  logger.debug({ jobId: key, stage, percent }, 'scraper progress');
  return res.json({ accepted: true, job: job.toJSON() });
}

module.exports = { report };