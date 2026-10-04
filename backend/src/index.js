'use strict';

/** LeadForge AI API server entrypoint. */

const { createApp } = require('./app');
const env = require('./config/env');
const logger = require('./config/logger');
const { closeQueue, initQueue } = require('./queue');
const { connectDb, disconnectDb } = require('./db/connect');

async function start() {
  await connectDb();

  const app = createApp();

  // Initialising the queue eagerly surfaces a bad Redis/DB configuration at
  // boot rather than on the first job.
  await initQueue();

  const server = app.listen(env.port, () => {
    logger.info(
      {
        port: env.port,
        mode: env.isMock ? 'mock' : 'live',
        env: env.nodeEnv,
        scraperUrl: env.scraperUrl,
      },
      'LeadForge AI API listening'
    );
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await closeQueue().catch(() => {});
    await disconnectDb().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    logger.fatal({ err: error.message, stack: error.stack }, 'failed to start server');
    process.exit(1);
  });
}

module.exports = { start };