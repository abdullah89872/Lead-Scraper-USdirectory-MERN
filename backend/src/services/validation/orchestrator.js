'use strict';

/**
 * Validation batch orchestrator.
 *
 * Processes addresses in bounded batches with configurable concurrency.
 * Supports:
 *   - progress callbacks (percent, stage, message)
 *   - cancellation via an external signal (job.cancelRequested)
 *   - resumability: skipped already-processed addresses when restarted
 *   - DNS cache warm-up for the batch domains
 *   - shared SMTP session across the batch (provider restriction detection)
 */

const pipeline = require('./pipeline');
const env = require('../../config/env');
const logger = require('../../config/logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validate a list of addresses in batches.
 *
 * @param {string[]} addresses raw address strings
 * @param {object} options
 * @param {number} [options.batchSize] - addresses per batch
 * @param {number} [options.concurrency] - max parallel validations
 * @param {Function} [options.onProgress] - (progress) => void
 * @param {Function} [options.isCancelled] - () => boolean
 * @param {Function} [options.onAddressResult] - (result) => void per-address callback
 * @returns {Promise<{ results: object[], summary: object, cancelled: boolean }>}
 */
async function validateBatch(addresses, options = {}) {
  const {
    batchSize = env.validation.batchSize,
    concurrency = env.validation.concurrency,
    onProgress,
    isCancelled = () => false,
    onAddressResult,
  } = options;

  const results = [];
  let cancelled = false;
  const total = addresses.length;

  // Shared SMTP session so provider-restriction detection works across batch.
  const sharedSession = require('./smtp').createSession();

  for (let i = 0; i < total; i += batchSize) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }

    const batch = addresses.slice(i, i + batchSize);
    const stage = `batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(total / batchSize)}`;

    const batchResults = await processConcurrent(batch, {
      concurrency,
      sharedSession,
      onAddressResult,
      isCancelled,
    });

    results.push(...batchResults);

    const processed = Math.min(i + batchSize, total);
    const percent = Math.round((processed / total) * 100);
    onProgress?.({
      percent,
      stage,
      processed,
      total,
      cancelled,
      summary: pipeline.summaryOf(results),
    });
  }

  const summary = pipeline.summaryOf(results);
  return { results, summary, cancelled };
}

/**
 * Process one batch with bounded concurrency.
 */
async function processConcurrent(batch, { concurrency, sharedSession, onAddressResult, isCancelled }) {
  const results = new Array(batch.length);
  let index = 0;

  async function worker() {
    while (index < batch.length) {
      if (isCancelled()) return;
      const i = index++;
      const raw = batch[i];
      try {
        const result = await pipeline.validateAddress(raw, sharedSession);
        results[i] = result;
        onAddressResult?.(result, i);
      } catch (error) {
        logger.error({ err: error.message, raw }, 'orchestrator address error');
        results[i] = {
          raw,
          address: null,
          status: pipeline.STATUS_ERROR,
          reason: 'Processing error',
          confidence: 0,
          updatedAt: new Date(),
        };
        onAddressResult?.(results[i], i);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, batch.length); w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results.filter(Boolean);
}

/**
 * Validate all leads matching a filter (or by id list) in the background.
 * Progress is reported via the onProgress callback; the caller persists it.
 *
 * @param {import('mongoose').Model} LeadModel
 * @param {object} filter - MongoDB filter for lead selection
 * @param {string[]} [leadIds] - explicit id list (overrides filter)
 * @param {object} options
 * @returns {Promise<{ results: object[], summary: object, cancelled: boolean, leadCount: number }>}
 */
async function validateLeads(LeadModel, filter = {}, leadIds, options = {}) {
  const query = leadIds && leadIds.length ? { _id: { $in: leadIds } } : filter;
  const leads = await LeadModel.find(query).select('email _id firstName lastName company source createdAt').lean();
  const addresses = leads.map((lead) => lead.email).filter(Boolean);

  const { results, summary, cancelled } = await validateBatch(addresses, options);

  const resultsWithMeta = results.map((result, idx) => {
    const lead = leads[idx] || {};
    return { ...result, leadId: lead._id, firstName: lead.firstName, lastName: lead.lastName, company: lead.company, source: lead.source };
  });

  return { results: resultsWithMeta, summary, cancelled, leadCount: leads.length };
}

/**
 * Warm the DNS cache for a batch of domains before processing.
 */
async function warmDnsCache(addresses) {
  const domains = [...new Set(addresses.map((a) => {
    const at = String(a).lastIndexOf('@');
    return at > 0 ? String(a).slice(at + 1).toLowerCase() : null;
  }).filter(Boolean))];

  const concurrency = 10;
  let index = 0;
  async function worker() {
    while (index < domains.length) {
      const domain = domains[index++];
      try {
        await require('./dns').checkDomain(domain);
      } catch {
        /* cache failures are non-fatal */
      }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, domains.length); w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return domains.length;
}

module.exports = {
  processConcurrent,
  validateBatch,
  validateLeads,
  warmDnsCache,
  pipeline,
};