'use strict';

/**
 * Route-level smoke test.
 *
 * Verifies that the Express app wires up correctly - middleware ordering,
 * validation, auth guards and the 404 handler - WITHOUT needing MongoDB.
 * The full jest suite covers behaviour against a real (in-memory) database.
 *
 *   node smoke.js
 */

process.env.NODE_ENV = 'test';
process.env.SCRAPER_MODE = 'mock';
process.env.QUEUE_DRIVER = 'inline';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-test-secret-value-long-enough';
process.env.LOG_LEVEL = 'silent';

const request = require('supertest');
const { createApp } = require('./src/app');

const app = createApp();

// [method, path, expected status]
const CHECKS = [
  ['get', '/api/health', 200],
  ['get', '/', 200],
  ['get', '/api/nope', 404],
  ['get', '/api/auth/me', 401],
  ['get', '/api/leads', 401],
  ['get', '/api/leads/export/csv', 401],
  ['post', '/api/jobs', 401],
  ['get', '/api/jobs', 401],
  ['post', '/api/jobs/abc/cancel', 401],
  ['get', '/api/dashboard/stats', 401],
  ['get', '/api/settings', 401],
  ['get', '/api/lists', 401],
  ['get', '/api/exports', 401],
  ['post', '/api/internal/jobs/abc/progress', 401],
  // Unauthenticated requests never reach the database, so validation runs first.
  ['post', '/api/auth/register', 400],
  ['post', '/api/auth/login', 400],
];

async function run() {
  let pass = 0;
  let fail = 0;

  for (const [method, url, expected] of CHECKS) {
    // eslint-disable-next-line no-await-in-loop
    const response = await request(app)[method](url).send({});
    const ok = response.status === expected;
    if (ok) pass += 1;
    else fail += 1;
    const label = ok ? 'PASS' : 'FAIL';
    console.log(`${label}  ${method.toUpperCase().padEnd(5)} ${url.padEnd(38)} -> ${response.status} (want ${expected})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((error) => {
  console.error('Smoke test crashed:', error.message);
  process.exit(1);
});