'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');

let memoryServer = null;
let connectionEventsRegistered = false;

/**
 * Connect to the configured persistent MongoDB deployment.
 * The ephemeral server is intentionally available only to the test suite.
 */
async function connectDb() {
  mongoose.set('strictQuery', true);
  mongoose.set('bufferCommands', false);
  registerConnectionEvents();

  if (env.isTest && process.env.DB_DRIVER === 'memory') {
    return startMemoryDb();
  }

  if (!env.mongodbUri) {
    throw new Error('MONGODB_URI is required. Configure a MongoDB Atlas connection string in backend/.env.');
  }

  try {
    await mongoose.connect(env.mongodbUri, {
      dbName: env.mongodbDbName,
      serverSelectionTimeoutMS: env.mongodbServerSelectionTimeoutMs,
      connectTimeoutMS: env.mongodbConnectTimeoutMs,
      socketTimeoutMS: env.mongodbSocketTimeoutMs,
      maxPoolSize: env.mongodbMaxPoolSize,
    });
    logger.info({ database: env.mongodbDbName }, 'connected to MongoDB');
    return mongoose.connection;
  } catch (error) {
    const message = safeErrorMessage(error);
    logger.error({ errorName: error.name, code: error.code, err: message }, 'MongoDB connection failed');
    throw new Error(
      `Could not connect to MongoDB database "${env.mongodbDbName}": ${message}. `
      + 'Check MONGODB_URI, Atlas Network Access, and the database user permissions.'
    );
  }
}

function registerConnectionEvents() {
  if (connectionEventsRegistered) return;
  connectionEventsRegistered = true;

  mongoose.connection.on('disconnected', () => {
    logger.warn({ database: env.mongodbDbName }, 'MongoDB connection lost; waiting for reconnection');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info({ database: env.mongodbDbName }, 'MongoDB connection restored');
  });
  mongoose.connection.on('error', (error) => {
    logger.error(
      { errorName: error.name, code: error.code, err: safeErrorMessage(error) },
      'MongoDB connection error'
    );
  });
}

async function startMemoryDb() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create({
    instance: { launchTimeout: 60000 },
  });
  await mongoose.connect(memoryServer.getUri(env.mongodbDbName), {
    dbName: env.mongodbDbName,
    serverSelectionTimeoutMS: env.mongodbServerSelectionTimeoutMs,
    connectTimeoutMS: env.mongodbConnectTimeoutMs,
    socketTimeoutMS: env.mongodbSocketTimeoutMs,
    maxPoolSize: env.mongodbMaxPoolSize,
  });
  logger.info('connected to isolated in-memory MongoDB for tests');
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
  return String(uri)
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@/]+@/i, '$1[redacted]@')
    .replace(/([?&](?:password|pwd)=)[^&\s]+/gi, '$1[redacted]');
}

function safeErrorMessage(error) {
  return redact(String(error?.message || 'Unknown MongoDB connection error'));
}

module.exports = { connectDb, disconnectDb, redact };
