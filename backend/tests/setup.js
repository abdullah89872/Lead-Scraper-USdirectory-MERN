'use strict';

/**
 * Jest global setup: point every test at an isolated in-memory MongoDB and
 * force mock mode, so the suite never touches a real database, Redis, the
 * Python service or USdirectory.
 */

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
process.env.ALLOW_MEMORY_DB = 'true';
process.env.SCRAPER_MODE = 'mock';
process.env.QUEUE_DRIVER = 'inline';
process.env.WORKER_ENABLED = 'true';
process.env.AI_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.JWT_SECRET = 'test-secret-value-for-jwt-signing-only';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '4'; // keep the suite fast

jest.setTimeout(120000);