'use strict';

const rateLimit = require('express-rate-limit');

const jsonError = (message) => (req, res) => res.status(429).json({ error: message });

/** Broad API limiter: protects the whole surface from abuse. */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonError('Too many requests - please slow down.'),
});

/** Stricter limiter for credential endpoints (brute-force protection). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonError('Too many authentication attempts. Try again later.'),
});

/** Job creation limiter: scraping is expensive, keep it sane. */
const jobLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonError('Too many scrape jobs started - please wait a moment.'),
});

/** Export limiter: server-side exports are heavyweight. */
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonError('Too many export requests - please wait a moment.'),
});

module.exports = { apiLimiter, authLimiter, exportLimiter, jobLimiter };
