'use strict';

/**
 * Live job progress over Server-Sent Events.
 *
 * SSE (rather than WebSockets) is used because progress is strictly one-way
 * (server -> browser) and SSE survives proxies without extra configuration.
 * The job's `progress` sub-document is polled in MongoDB, which keeps the
 * endpoint stateless and correct across multiple API instances.
 */

const jwt = require('jsonwebtoken');
const Job = require('../models/Job');
const User = require('../models/User');
const env = require('../config/env');
const logger = require('../config/logger');
const { asyncHandler } = require('../middleware/validate');

const POLL_INTERVAL_MS = 700;
const MAX_STREAM_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

function serialize(job) {
  return {
    id: job.id,
    status: job.status,
    category: job.category,
    location: job.location,
    source: job.source,
    progress: job.progress,
    leadsCount: job.leadsCount,
    error: job.error,
    warnings: job.warnings,
  };
}

/** GET /api/jobs/:id/progress - SSE stream of job progress events. */
const stream = asyncHandler(async (req, res) => {
  // EventSource cannot set an Authorization header, so the SSE endpoint also
  // accepts the JWT as a query parameter. It is validated exactly like the
  // header-based flow and never logged.
  if (!req.user) {
    const token = String(req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      const owner = await User.findById(payload.sub);
      if (!owner) return res.status(401).json({ error: 'Account no longer exists' });
      req.user = owner;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
  }

  const job = await Job.findOne({ _id: req.params.id, user: req.user._id });
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  let lastPayload = '';

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const stop = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(poller);
    clearTimeout(deadline);
    send('end', { reason });
    res.end();
  };

  req.on('close', () => stop('client disconnected'));

  // A comment frame every 15s keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  const deadline = setTimeout(() => stop('stream timeout'), MAX_STREAM_MS);

  const poller = setInterval(async () => {
    try {
      const current = await Job.findById(req.params.id);
      if (!current) return stop('job removed');
      const payload = JSON.stringify(serialize(current));
      if (payload !== lastPayload) {
        lastPayload = payload;
        send('progress', serialize(current));
      }
      if (TERMINAL_STATUSES.includes(current.status)) {
        clearInterval(heartbeat);
        return stop(current.status);
      }
    } catch (error) {
      logger.debug({ err: error.message, jobId: req.params.id }, 'progress poll failed');
    }
    return undefined;
  }, POLL_INTERVAL_MS);

  send('progress', serialize(job));
  if (TERMINAL_STATUSES.includes(job.status)) {
    clearInterval(heartbeat);
    stop(job.status);
  }

  return undefined;
});

module.exports = { stream };