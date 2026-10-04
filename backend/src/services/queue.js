'use strict';

/**
 * Job queue abstraction.
 *
 * QUEUE_DRIVER=redis  -> BullMQ + Redis (production)
 * QUEUE_DRIVER=inline -> in-process runner (single node / tests)
 * QUEUE_DRIVER=auto   -> BullMQ when Redis answers, otherwise inline
 *
 * Both drivers execute the same handler, so behaviour is identical; only the
 * distribution changes. Users would never notice a difference in the UI.
 */

const env = require('../config/env');
const logger = require('../config/logger');

const QUEUE_NAME = 'leadforge:scrape';

class InlineQueue {
  constructor({ handler, concurrency = 2 }) {
    this.handler = handler;
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.pending = [];
    this.driver = 'inline';
  }

  async add(jobId) {
    this.pending.push(String(jobId));
    this.drain();
    return { id: String(jobId) };
  }

  drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const jobId = this.pending.shift();
      this.running += 1;
      Promise.resolve()
        .then(() => this.handler(jobId))
        .catch((error) => logger.error({ err: error.message, jobId }, 'inline job failed'))
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  async cancel(jobId) {
    this.pending = this.pending.filter((id) => id !== String(jobId));
    return true;
  }

  async close() {
    this.pending = [];
    return true;
  }
}

class BullQueue {
  constructor({ queue, worker }) {
    this.queue = queue;
    this.worker = worker;
    this.driver = 'redis';
  }

  async add(jobId) {
    const id = String(jobId);
    await this.queue.add(
      'scrape',
      { jobId: id },
      { jobId: id, attempts: 1, removeOnComplete: 200, removeOnFail: 500 }
    );
    return { id };
  }

  async cancel(jobId) {
    const job = await this.queue.getJob(String(jobId));
    if (!job) return false;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
    }
    return true;
  }

  async close() {
    await this.worker.close();
    await this.queue.close();
  }
}

async function redisAvailable() {
  const IORedis = require('ioredis');
  const client = new IORedis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    connectTimeout: 2500,
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch (error) {
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    logger.debug({ err: error.message }, 'redis not reachable');
    return null;
  }
}

/**
 * Create the queue. Returns `{ driver, queue, close }`.
 * @param {(jobId: string) => Promise<unknown>} handler
 */
async function createQueue({ handler, concurrency = env.queueConcurrency }) {
  const driver = env.queueDriver;

  if (driver !== 'inline') {
    const connection = await redisAvailable();
    if (connection) {
      const { Queue, Worker } = require('bullmq');
      const bullConnection = { connection };
      const queue = new Queue(QUEUE_NAME, { connection: bullConnection });
      const worker = new Worker(
        QUEUE_NAME,
        async (job) => handler(job.data.jobId),
        { connection: bullConnection, concurrency: Math.max(1, concurrency) }
      );
      worker.on('failed', (job, error) => {
        logger.error({ jobId: job?.id, err: error.message }, 'bullmq job failed');
      });
      logger.info({ driver: 'redis', redis: env.redisUrl }, 'queue ready');
      return new BullQueue({ queue, worker });
    }
    if (driver === 'redis') {
      throw new Error(`QUEUE_DRIVER=redis but Redis at ${env.redisUrl} is not reachable`);
    }
    logger.warn('Redis unavailable - running jobs inline in this process');
  }

  logger.info({ driver: 'inline' }, 'queue ready');
  return new InlineQueue({ handler, concurrency });
}

module.exports = { BullQueue, InlineQueue, QUEUE_NAME, createQueue, redisAvailable };
