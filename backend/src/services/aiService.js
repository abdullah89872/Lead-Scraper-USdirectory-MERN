'use strict';

/**
 * AI service (optional).
 *
 * The AI only ever *categorises, tags and summarises* data that was already
 * collected, and it is explicitly told never to invent contact information.
 * AI output is stored in dedicated ai* fields, separate from source data.
 * Every call is cached in MongoDB so identical inputs are never billed twice.
 * If AI fails, scraping continues unaffected.
 */

const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const AiCache = require('../models/AiCache');

const SYSTEM_PROMPT = [
  'You are a business data normalization assistant for a lead-generation tool.',
  'You receive data that was already collected from public business listings.',
  'Rules you must never break:',
  '1. NEVER invent, guess or "complete" contact information (phone numbers, email addresses, websites, addresses).',
  '2. Only use the information provided in the input.',
  '3. If a field cannot be determined from the input, use null or an empty array.',
  '4. Respond with JSON only - no prose, no markdown fences.',
].join('\n');

const TASK_SCHEMA = `{
  "category": string|null,          // normalized business category
  "services": string[],             // concrete services the business appears to offer
  "tags": string[],                 // short descriptive tags (e.g. "family-owned")
  "shortDescription": string|null   // <= 240 characters, factual, no contact info
}`;

let client = null;

function isEnabled() {
  return Boolean(env.aiEnabled && env.openaiApiKey);
}

function getClient() {
  if (!client) {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: env.openaiApiKey, timeout: env.openaiTimeoutMs });
  }
  return client;
}

function cacheKey(task, input) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `${task}:${env.openaiModel}:${hash}`;
}

/**
 * Ask the model to categorise/tag a lead.
 * @returns {Promise<{category: string|null, services: string[], tags: string[], shortDescription: string|null}>}
 */
async function analyzeLead(lead, { useCache = true } = {}) {
  const input = {
    businessName: lead.businessName,
    category: lead.category,
    description: lead.description,
    city: lead.city,
    state: lead.state,
    services: lead.services,
    source: lead.source,
  };
  const key = cacheKey('analyzeLead', input);

  if (useCache) {
    const cached = await AiCache.findOne({ key }).lean();
    if (cached?.payload) {
      logger.debug({ key }, 'ai cache hit');
      return cached.payload;
    }
  }

  const completion = await getClient().chat.completions.create({
    model: env.openaiModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Given this business listing, return JSON matching this shape:\n${TASK_SCHEMA}\n\n` +
          `Input data:\n${JSON.stringify(input, null, 2)}`,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    logger.warn('ai returned non-JSON content; ignoring');
    parsed = {};
  }

  const payload = {
    category: typeof parsed.category === 'string' ? parsed.category : null,
    services: Array.isArray(parsed.services) ? parsed.services.slice(0, 25) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 25) : [],
    shortDescription:
      typeof parsed.shortDescription === 'string' ? parsed.shortDescription.slice(0, 240) : null,
  };

  try {
    await AiCache.updateOne(
      { key },
      { $set: { key, task: 'analyzeLead', model: env.openaiModel, payload } },
      { upsert: true }
    );
  } catch (error) {
    logger.debug({ err: error.message }, 'failed to cache ai response');
  }

  return payload;
}

/** Apply AI output to a lead document. Never throws. */
async function enrichLead(lead) {
  if (!isEnabled()) return null;
  try {
    const result = await analyzeLead(lead);
    lead.aiCategory = result.category;
    lead.aiServices = result.services;
    lead.aiTags = result.tags;
    lead.aiDescription = result.shortDescription;
    lead.aiGeneratedAt = new Date();
    return result;
  } catch (error) {
    // AI is strictly optional: log and carry on.
    logger.warn({ err: error.message, lead: lead.businessName }, 'ai enrichment failed');
    lead.notes = Array.from(new Set([...(lead.notes || []), `AI processing skipped: ${error.message}`]));
    return null;
  }
}

/** Enrich many leads with bounded concurrency. */
async function enrichLeads(leads, { concurrency = 3 } = {}) {
  if (!isEnabled() || leads.length === 0) return { processed: 0, failed: 0 };
  let processed = 0;
  let failed = 0;
  const queue = [...leads];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const lead = queue.shift();
      if (!lead) break;
      const result = await enrichLead(lead);
      if (result) processed += 1;
      else failed += 1;
    }
  });

  await Promise.all(workers);
  return { processed, failed };
}

module.exports = { analyzeLead, cacheKey, enrichLead, enrichLeads, isEnabled };
