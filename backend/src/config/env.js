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

/** Parsed integer clamped to [min, max]; falls back on garbage input. */
const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 4000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  jwtSecret: process.env.JWT_SECRET || 'development-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 10),

  mongodbUri: process.env.MONGODB_URI || '',
  mongodbDbName: process.env.MONGODB_DB_NAME || 'leadforge',
  mongodbServerSelectionTimeoutMs: clampInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10000, 1000, 120000),
  mongodbConnectTimeoutMs: clampInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10000, 1000, 120000),
  mongodbSocketTimeoutMs: clampInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 45000, 1000, 300000),
  mongodbMaxPoolSize: clampInt(process.env.MONGODB_MAX_POOL_SIZE, 20, 1, 500),

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

  // HTTP rate limits (requests per window). Kept in config so deployments and
  // the test suite can tune them without editing code.
  rateLimit: {
    apiPerMin: clampInt(process.env.RATE_LIMIT_API_PER_MIN, 300, 1, 1000000),
    authPer15Min: clampInt(process.env.RATE_LIMIT_AUTH_PER_15MIN, 30, 1, 1000000),
    jobsPerMin: clampInt(process.env.RATE_LIMIT_JOBS_PER_MIN, 20, 1, 1000000),
    exportsPerMin: clampInt(process.env.RATE_LIMIT_EXPORTS_PER_MIN, 20, 1, 1000000),
    validationPerMin: clampInt(process.env.RATE_LIMIT_VALIDATION_PER_MIN, 30, 1, 1000000),
  },

  // ---- Email validation ----------------------------------------------------
  // Every value is clamped to a safe range so a bad .env cannot disable the
  // protections (0 concurrency, absurd timeouts, ...). See .env.example.
  validation: {
    // Validate leads automatically after each scrape job completes. Extraction
    // never depends on this: failures are logged, never fatal.
    auto: toBool(process.env.EMAIL_VALIDATION_AUTO, true),
    // 'dns'  -> VALID needs syntax + domain evidence only (SMTP is advisory)
    // 'smtp' -> VALID additionally needs a positive SMTP acceptance.
    validPolicy: (process.env.EMAIL_VALIDATION_VALID_POLICY || 'smtp').toLowerCase() === 'smtp'
      ? 'smtp'
      : 'dns',
    // Treat role-based addresses (info@, sales@, ...) as RISKY. Off by default:
    // role accounts are flagged but keep the status earned by other checks.
    roleAsRisky: toBool(process.env.EMAIL_VALIDATION_ROLE_RISKY, false),
    batchSize: clampInt(process.env.EMAIL_VALIDATION_BATCH_SIZE, 200, 1, 5000),
    concurrency: clampInt(process.env.EMAIL_VALIDATION_CONCURRENCY, 10, 1, 100),
    maxEmailsPerRequest: clampInt(process.env.EMAIL_MAX_EMAILS_PER_REQUEST, 5000, 1, 100000),
    cacheTtlDays: clampInt(process.env.VALIDATION_CACHE_TTL_DAYS, 7, 1, 365),
    maxActiveJobsPerUser: clampInt(process.env.VALIDATION_MAX_ACTIVE_JOBS, 3, 1, 50),

    dns: {
      timeoutMs: clampInt(process.env.DNS_TIMEOUT_MS, 5000, 500, 60000),
      cacheTtlMs: clampInt(process.env.DNS_CACHE_TTL_MS, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
      // Temporary failures are cached briefly only, so a resolver hiccup never
      // blocks a retry for an hour but also cannot cause a query storm.
      negativeCacheTtlMs: clampInt(process.env.DNS_NEGATIVE_CACHE_TTL_MS, 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    },

    smtp: {
      enabled: toBool(process.env.EMAIL_SMTP_ENABLED, true),
      timeoutMs: clampInt(process.env.EMAIL_SMTP_TIMEOUT_MS, 10000, 1000, 120000),
      maxConcurrency: clampInt(process.env.EMAIL_SMTP_MAX_CONCURRENCY, 5, 1, 50),
      retryCount: clampInt(process.env.EMAIL_SMTP_RETRY_COUNT, 1, 0, 5),
      retryBackoffMs: clampInt(process.env.EMAIL_SMTP_RETRY_BACKOFF_MS, 500, 50, 60000),
      // Minimum spacing between outbound SMTP connections (respect_server_limits).
      minDelayMs: clampInt(process.env.EMAIL_SMTP_MIN_DELAY_MS, 250, 0, 60000),
      respectServerLimits: toBool(process.env.EMAIL_SMTP_RESPECT_SERVER_LIMITS, true),
      stopOnProviderRestriction: toBool(process.env.EMAIL_SMTP_STOP_ON_PROVIDER_RESTRICTION, true),
      // Envelope sender for MAIL FROM. The reserved example.com domain is used
      // when unset; no real mailbox is ever contacted or authenticated.
      envelopeFrom: (process.env.EMAIL_SMTP_ENVELOPE_FROM || 'probe@example.com').trim(),
      // Abort verification when the server does not offer STARTTLS.
      requireTls: toBool(process.env.EMAIL_SMTP_REQUIRE_TLS, false),
      maxMxTries: clampInt(process.env.EMAIL_SMTP_MAX_MX_TRIES, 3, 1, 10),
      // Optional same-session probe with an unguessable local part to detect
      // catch-all domains. Off by default to keep envelope traffic minimal.
      catchAllProbe: toBool(process.env.EMAIL_SMTP_CATCH_ALL_PROBE, false),
      // Destination port for MX verification (25 = standard SMTP submission
      // to a mail exchanger; override only for local/dev mail servers).
      port: clampInt(process.env.EMAIL_SMTP_PORT, 25, 1, 65535),
    },

    csv: {
      maxBytes: clampInt(process.env.CSV_UPLOAD_MAX_BYTES, 5 * 1024 * 1024, 1024, 50 * 1024 * 1024),
      maxRows: clampInt(process.env.CSV_UPLOAD_MAX_ROWS, 50000, 1, 1000000),
      maxColumns: clampInt(process.env.CSV_UPLOAD_MAX_COLUMNS, 100, 2, 500),
    },

    queueConcurrency: clampInt(process.env.VALIDATION_QUEUE_CONCURRENCY, 2, 1, 50),
  },

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
