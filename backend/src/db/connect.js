'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');

let memoryServer = null;

/**
 * Connect to MongoDB.
 *
 * DB_DRIVER=mongo  -> use MONGO_URI
 * DB_DRIVER=memory -> ephemeral in-process MongoDB (dev/testing only)
 *
 * When ALLOW_MEMORY_DB=true and the configured server is unreachable we fall
 * back to the in-memory server and log a loud warning, so the app is always
 * runnable in a fresh Windows environment without Docker.
 */
async function connectDb() {
  mongoose.set('strictQuery', true);

  const useMemory = env.dbDriver === 'memory' || (env.isTest && !process.env.MONGO_URI);

  if (useMemory) {
    return startMemoryDb('DB_DRIVER=memory');
  }

  try {
    await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 8000 });
    logger.info({ uri: redact(env.mongoUri) }, 'connected to MongoDB');
    return mongoose.connection;
  } catch (error) {
    if (!env.allowMemoryDb) throw error;
    logger.warn(
      { err: error.message },
      'MongoDB unreachable - falling back to an in-memory database (data is not persisted)'
    );
    return startMemoryDb(error.message);
  }
}

async function startMemoryDb(reason) {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  // The library's default 10s launch timeout is not always enough on a cold or
  // busy Windows host: mongod occasionally needs longer to boot, and the API
  // then dies with "Instance failed to start within 10000ms". Give it room.
  memoryServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  const uri = memoryServer.getUri('leadforge');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  logger.warn({ uri, reason }, 'using in-memory MongoDB (development only)');
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

function redact(uri) {
  return String(uri).replace(/\/\/[^@]+@/, '//***:***@');
}

module.exports = { connectDb, disconnectDb, redact };
