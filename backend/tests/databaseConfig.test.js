'use strict';

const mongoose = require('mongoose');
const env = require('../src/config/env');
const { connectDb } = require('../src/db/connect');
const { createApp } = require('../src/app');
const { errorHandler } = require('../src/middleware/validate');
const request = require('supertest');

const originalNodeEnv = env.nodeEnv;
const originalMongoUri = env.mongodbUri;
const originalDbName = env.mongodbDbName;
const originalDbDriver = process.env.DB_DRIVER;

afterEach(() => {
  env.nodeEnv = originalNodeEnv;
  env.mongodbUri = originalMongoUri;
  env.mongodbDbName = originalDbName;
  process.env.DB_DRIVER = originalDbDriver;
  jest.restoreAllMocks();
});

test('does not fall back to an ephemeral database outside tests', async () => {
  env.nodeEnv = 'development';
  env.mongodbUri = '';
  process.env.DB_DRIVER = 'memory';

  await expect(connectDb()).rejects.toThrow(/MONGODB_URI is required/);
  expect(mongoose.connection.readyState).toBe(0);
});

test('uses the configured database name and connection limits', async () => {
  env.nodeEnv = 'production';
  env.mongodbUri = 'mongodb+srv://user:secret@cluster.example.mongodb.net/';
  env.mongodbDbName = 'leadforge_test_config';
  const connect = jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);

  await connectDb();

  expect(connect).toHaveBeenCalledWith(env.mongodbUri, {
    dbName: 'leadforge_test_config',
    serverSelectionTimeoutMS: env.mongodbServerSelectionTimeoutMs,
    connectTimeoutMS: env.mongodbConnectTimeoutMs,
    socketTimeoutMS: env.mongodbSocketTimeoutMs,
    maxPoolSize: env.mongodbMaxPoolSize,
  });
});

test('redacts database credentials from connection errors', async () => {
  env.nodeEnv = 'production';
  env.mongodbUri = 'mongodb+srv://user:secret@cluster.example.mongodb.net/';
  const connect = jest.spyOn(mongoose, 'connect').mockRejectedValue(
    new Error('Connection failed for mongodb+srv://user:secret@cluster.example.mongodb.net/')
  );

  let message;
  try {
    await connectDb();
  } catch (error) {
    message = error.message;
  }
  expect(message).toMatch(/\[redacted\]@/);
  expect(message).not.toContain('secret');
});

test('reports a disconnected database as unavailable', async () => {
  const response = await request(createApp()).get('/api/health');

  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({
    status: 'unavailable',
    service: 'leadforge-api',
    database: 'disconnected',
  });
});

test('returns a service-unavailable response for unbuffered disconnected queries', () => {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };

  errorHandler(
    new mongoose.Error('Cannot query while MongoDB is disconnected'),
    { log: { error: jest.fn() } },
    response,
    jest.fn()
  );

  expect(response.status).toHaveBeenCalledWith(503);
  expect(response.json).toHaveBeenCalledWith({
    error: 'Database is temporarily unavailable. Please retry shortly.',
  });
});
