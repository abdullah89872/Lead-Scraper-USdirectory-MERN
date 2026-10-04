'use strict';

/** Queue singleton shared by the API and the worker entrypoint. */

const env = require('./config/env');
const logger = require('./config/logger');
const { createQueue } = require('./services/queue');
const { runJob } = require('./services/jobRunner');

let instance = null;

async function initQueue() {
  if (instance) return instance;
  instance = await createQueue({ handler: runJob, concurrency: env.queueConcurrency });
  return instance;
}

async function addJob(jobId) {
  const queue = await initQueue();
  if (!env.workerEnabled && queue.driver === 'inline') {
    logger.warn(
      'WORKER_ENABLED=false with the inline driver: queued jobs will not run in this process'
    );
  }
  if (!env.workerEnabled && queue.driver === 'redis') {
    // Queue only - a separate worker process (`npm run worker`) consumes jobs.
    const { Queue } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
    const queueOnly = new Queue('leadforge:scrape', { connection });
    return queueOnly.add('scrape', { jobId: String(jobId) }, { jobId: String(jobId) });
  }
  return queue.add(jobId);
}

async function cancelJob(jobId) {
  if (!instance) return false;
  return instance.cancel(jobId);
}

function queueDriver() {
  return instance ? instance.driver : null;
}

async function closeQueue() {
  if (!instance) return;
  await instance.close();
  instance = null;
}

module.exports = { addJob, cancelJob, closeQueue, driver: queueDriver, initQueue };
