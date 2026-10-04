'use strict';

require('dotenv').config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  jwtSecret: process.env.JWT_SECRET || 'development-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 10),

  dbDriver: (process.env.DB_DRIVER || 'mongo').toLowerCase(),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/leadforge',
  allowMemoryDb: toBool(process.env.ALLOW_MEMORY_DB, true),

  queueDriver: (process.env.QUEUE_DRIVER || 'auto').toLowerCase(),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  workerEnabled: toBool(process.env.WORKER_ENABLED, true),
  queueConcurrency: toInt(process.env.QUEUE_CONCURRENCY, 2),

  scraperMode: (process.env.SCRAPER_MODE || 'mock').toLowerCase(),
  scraperUrl: process.env.SCRAPER_URL || 'http://127.0.0.1:8000',
  // The rate limiter serialises every request to the same host, so a live crawl
  // costs roughly 2.8s per lead (measured 2026-04-10). The default job is 100
  // leads, which needs ~5-6 minutes before enrichment. The old 300000ms default
  // aborted those jobs at ~74% with "scraper service timed out".
  scraperTimeoutMs: toInt(process.env.SCRAPER_TIMEOUT_MS, 900000),
  internalApiToken: process.env.INTERNAL_API_TOKEN || 'change-me-internal-token',

  scrapeMaxLeads: toInt(process.env.SCRAPE_MAX_LEADS, 100),
  enrichmentEnabled: toBool(process.env.ENRICHMENT_ENABLED, true),

  aiEnabled: toBool(process.env.AI_ENABLED, false),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiTimeoutMs: toInt(process.env.OPENAI_TIMEOUT_MS, 30000),
  aiCacheTtlDays: toInt(process.env.AI_CACHE_TTL_DAYS, 30),

  logLevel: process.env.LOG_LEVEL || 'info',

  get isProduction() {
    return this.nodeEnv === 'production';
  },
  get isMock() {
    return this.scraperMode === 'mock';
  },
  get isTest() {
    return this.nodeEnv === 'test';
  },
};

module.exports = env;
