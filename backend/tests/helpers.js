'use strict';

/** Shared test helpers: app instance, DB lifecycle and authenticated clients. */

const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const User = require('../src/models/User');
const { connectDb, disconnectDb } = require('../src/db/connect');
const { closeQueue } = require('../src/queue');

const app = createApp();

let started = false;

async function startDb() {
  if (!started) {
    await connectDb();
    started = true;
  }
}

async function stopDb() {
  await closeQueue().catch(() => {});
  await disconnectDb().catch(() => {});
  started = false;
}

async function clearDb() {
  await Promise.all([
    mongoose.modelNames().map((name) => mongoose.connection.collection(name).deleteMany({})),
  ]);
}

async function createUser({ email, password = 'Password123!', role = 'user', name = 'Test User' } = {}) {
  return User.create({
    name,
    email,
    passwordHash: await User.hashPassword(password),
    role,
  });
}

/** An agent with a valid Bearer token for the given user. */
async function authClient(user) {
  const { signToken } = require('../src/middleware/auth');
  return {
    token: signToken(user),
    get: (url) => request(app).get(url).set('Authorization', `Bearer ${signToken(user)}`),
    post: (url) => request(app).post(url).set('Authorization', `Bearer ${signToken(user)}`),
    patch: (url) => request(app).patch(url).set('Authorization', `Bearer ${signToken(user)}`),
    delete: (url) => request(app).delete(url).set('Authorization', `Bearer ${signToken(user)}`),
  };
}

/** Register a user through the API and return a ready-to-use client. */
async function registerUser(overrides = {}) {
  const payload = {
    name: 'Test User',
    email: `user${Date.now()}${Math.random().toString(36).slice(2, 7)}@example.test`,
    password: 'Password123!',
    ...overrides,
  };
  const response = await request(app).post('/api/auth/register').send(payload);
  return { response, client: await authClient(response.body.user), payload };
}

/** Poll a job until it reaches a terminal status (inline queue runs fast). */
async function waitForJob(jobId, { timeoutMs = 30000 } = {}) {
  const Job = require('../src/models/Job');
  const deadline = Date.now() + timeoutMs;
  const terminal = ['completed', 'failed', 'cancelled'];
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const job = await Job.findById(jobId);
    if (job && terminal.includes(job.status)) return job;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

module.exports = {
  app,
  authClient,
  clearDb,
  createUser,
  registerUser,
  request,
  startDb,
  stopDb,
  waitForJob,
};