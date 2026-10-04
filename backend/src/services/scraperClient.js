'use strict';

/**
 * HTTP client for the Python FastAPI scraper service.
 *
 * The backend never scrapes by itself in live mode: it delegates to the
 * scraper, which owns robots.txt compliance, rate limiting and back-off.
 */

const env = require('../config/env');
const logger = require('../config/logger');

class ScraperServiceError extends Error {
  constructor(message, { status = null, blocked = false } = {}) {
    super(message);
    this.name = 'ScraperServiceError';
    this.status = status;
    this.blocked = blocked;
  }
}

async function request(path, { method = 'GET', body = null, timeoutMs = env.scraperTimeoutMs } = {}) {
  const url = `${env.scraperUrl.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new ScraperServiceError(
        `scraper service responded ${response.status}: ${payload?.detail || text?.slice(0, 300)}`,
        { status: response.status }
      );
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      // A crawl is serialised per host (~2.8s per lead measured live), so a job
      // that outruns this budget is usually just too large rather than broken.
      // Say what to change instead of leaving the operator with a bare number.
      const perLead = 3;
      const affordable = Math.floor(timeoutMs / 1000 / perLead);
      throw new ScraperServiceError(
        `scraper service timed out after ${Math.round(timeoutMs / 1000)}s. `
          + `A live crawl is rate-limited to roughly one request every ${perLead}s, `
          + `so lower "max leads" to about ${affordable} or fewer, or raise `
          + `SCRAPER_TIMEOUT_MS (currently ${timeoutMs}ms).`,
        { status: 504 }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Run a scrape through the Python service (live mode). */
async function scrape({
  category,
  location,
  maxLeads,
  source = 'usdirectory',
  enrichment = true,
  ai = false,
  jobId = null,
  progressUrl = null,
  progressToken = null,
}) {
  logger.info({ category, location, maxLeads, source }, 'dispatching scrape to python service');
  return request('/scrape', {
    method: 'POST',
    body: {
      category,
      location,
      max_leads: maxLeads,
      source,
      enrichment,
      ai,
      job_id: jobId,
      progress_url: progressUrl,
      progress_token: progressToken || env.internalApiToken,
    },
  });
}

/** Enrich a single lead through the Python service. */
async function enrich(lead) {
  return request('/enrich', { method: 'POST', body: { lead } });
}

async function health() {
  try {
    return await request('/health', { timeoutMs: 5000 });
  } catch (error) {
    return { status: 'unreachable', error: error.message };
  }
}

async function sources() {
  try {
    return await request('/sources', { timeoutMs: 5000 });
  } catch (error) {
    return { mode: env.scraperMode, sources: [], error: error.message };
  }
}

module.exports = { ScraperServiceError, enrich, health, request, scrape, sources };
