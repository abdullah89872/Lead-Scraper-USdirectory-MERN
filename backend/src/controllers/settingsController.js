'use strict';

/** Runtime settings for the dashboard "Settings" page (never exposes secrets). */

const { asyncHandler } = require('../middleware/validate');
const aiService = require('../services/aiService');
const env = require('../config/env');
const { driver: queueDriver } = require('../queue');
const scraperClient = require('../services/scraperClient');

/** GET /api/settings */
const read = asyncHandler(async (req, res) => {
  let scraper = { mode: env.scraperMode, url: env.scraperUrl, reachable: false, info: null };
  try {
    scraper = { ...scraper, reachable: true, info: await scraperClient.health() };
  } catch {
    /* leave reachable=false - the UI shows an offline badge */
  }

  return res.json({
    scraper,
    queue: { driver: queueDriver(), concurrency: env.queueConcurrency },
    ai: {
      enabled: env.aiEnabled && aiService.isEnabled(),
      configured: aiService.isEnabled(),
      model: env.openaiModel,
    },
    enrichment: { enabled: env.enrichmentEnabled },
    limits: { scrapeMaxLeads: env.scrapeMaxLeads },
    user: { email: req.user.email, name: req.user.name, role: req.user.role },
  });
});

module.exports = { read };