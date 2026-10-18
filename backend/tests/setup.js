'use strict';

/**
 * Jest global setup: point every test at an isolated in-memory MongoDB and
 * force mock mode, so the suite never touches a real database, Redis, the
 * Python service or USdirectory.
 */

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
process.env.MONGODB_URI = '';
process.env.SCRAPER_MODE = 'mock';
process.env.QUEUE_DRIVER = 'inline';
process.env.WORKER_ENABLED = 'true';
process.env.AI_ENABLED = 'false';
process.env.OPENAI_API_KEY = '';
process.env.EMAIL_VALIDATION_VALID_POLICY = 'dns';
process.env.EMAIL_SMTP_ENABLED = 'false';
process.env.JWT_SECRET = 'test-secret-value-for-jwt-signing-only';
process.env.INTERNAL_API_TOKEN = 'test-internal-token';
process.env.LOG_LEVEL = 'silent';
process.env.BCRYPT_ROUNDS = '4'; // keep the suite fast

// The suite issues hundreds of requests from one IP in under a minute; the
// production rate limits would 429 unrelated tests. Raise them for tests only.
process.env.RATE_LIMIT_API_PER_MIN = '1000000';
process.env.RATE_LIMIT_AUTH_PER_15MIN = '1000000';
process.env.RATE_LIMIT_JOBS_PER_MIN = '1000000';
process.env.RATE_LIMIT_EXPORTS_PER_MIN = '1000000';
process.env.RATE_LIMIT_VALIDATION_PER_MIN = '1000000';

jest.setTimeout(120000);