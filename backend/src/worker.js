'use strict';

/**
 * Standalone queue worker.
 *
 * Run this as a separate process when WORKER_ENABLED=false so the API only
 * enqueues and job execution scales independently:
 *
 *   npm start     # API (WORKER_ENABLED=false)
 *   npm run worker
 */

const env = require('./config/env');
const logger = require('./config/logger');
const { connectDb, disconnectDb } = require('./db/connect');
const { closeQueue, initQueue } = require('./queue');

async function main() {
  await connectDb();

  // initQueue creates a BullMQ consumer when Redis is reachable, and an inline
  // runner otherwise - either way jobs start draining immediately.
  const queue = await initQueue();
  logger.info({ driver: queue.driver, concurrency: env.queueConcurrency }, 'worker ready');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'worker shutting down');
    await closeQueue().catch(() => {});
    await disconnectDb().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
}

main().catch((error) => {
  logger.fatal({ err: error.message, stack: error.stack }, 'worker failed to start');
  process.exit(1);
});