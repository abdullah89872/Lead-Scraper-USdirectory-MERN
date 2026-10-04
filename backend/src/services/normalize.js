'use strict';

/**
 * Normalization helpers shared by the job runner, the API and the tests.
 *
 * These mirror the Python scraper validators so a lead looks identical no
 * matter which side performed the extraction. Missing data is never invented:
 * unusable values normalize to null.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const PHONE_RE = /(?:(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4})/g;

const JUNK_SUFFIXES = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.css', '.js',
  '.woff', '.woff2', '.ttf', '.ico', '.pdf',
];
const JUNK_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'sentry.io',
  'domain.com', 'yourdomain.com',
];
const JUNK_LOCAL_PARTS = ['example', 'email', 'yourname', 'name', 'user', 'test'];

const DEOBFUSCATE_RULES = [
  [/\s*\[\s*at\s*\]\s*/gi, '@'],
  [/\s*\(\s*at\s*\)\s*/gi, '@'],
  [/\s*\[\s*dot\s*\]\s*/gi, '.'],
  [/\s*\(\s*dot\s*\)\s*/gi, '.'],
];

function deobfuscate(text) {
  if (!text) return '';
  return DEOBFUSCATE_RULES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), String(text));
}

function normalizeEmail(value) {
  if (!value) return null;
  let email = String(value).trim().replace(/^mailto:/i, '').split('?')[0];
  // Only *trailing* punctuation is noise. Dots inside the domain are part of
  // the address and must survive.
  email = email.replace(/[.,;:()<>[\]"'`]+$/g, '').replace(/^[<("'`]+/, '');
  email = email.replace(/\s+/g, '');
  if (!email || !email.includes('@')) return null;
  return email.toLowerCase();
}

function isValidEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const email = value.trim();
  if (email.length > 254) return false;
  const match = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,24}$/.exec(email);
  return Boolean(match);
}

function isJunkEmail(value) {
  if (!value) return true;
  const lower = value.toLowerCase();
  if (JUNK_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  const [local, domain] = lower.split('@');
  if (!domain) return true;
  if (JUNK_DOMAINS.includes(domain)) return true;
  if (JUNK_LOCAL_PARTS.includes(local)) return true;
  if (local.startsWith('u00') || local.startsWith('x3')) return true;
  return false;
}

function extractEmails(text) {
  if (!text) return [];
  const found = [];
  const haystack = deobfuscate(text);
  for (const match of haystack.match(EMAIL_RE) || []) {
    const email = normalizeEmail(match);
    if (!email || found.includes(email)) continue;
    if (isJunkEmail(email) || !isValidEmail(email)) continue;
    found.push(email);
  }
  return found;
}

function normalizePhone(value) {
  if (!value) return null;
  const candidate = String(value).split(/ext|x/i)[0];
  let digits = candidate.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if ('01'.includes(digits[0]) || '01'.includes(digits[3])) return null;
  if (new Set(digits).size === 1) return null;
  return `+1${digits}`;
}

function formatPhone(value) {
  const e164 = normalizePhone(value);
  if (!e164) return null;
  const digits = e164.slice(2);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function extractPhones(text) {
  if (!text) return [];
  const found = [];
  for (const match of String(text).match(PHONE_RE) || []) {
    const phone = normalizePhone(match);
    if (phone && !found.includes(phone)) found.push(phone);
  }
  return found;
}

const clean = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
};

const unique = (values) => Array.from(new Set((values || []).filter(Boolean)));

function normalizeState(value) {
  if (!value) return null;
  const text = clean(value);
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  const { stateAbbr } = require('./usStates');
  return stateAbbr(text);
}

/** Normalize a raw lead object coming from the scraper service. */
function normalizeLead(raw = {}) {
  const businessName = clean(raw.businessName);
  const sourceUrl = clean(raw.sourceUrl);

  // A lead without a name or a traceable source URL is not usable and would
  // violate the "never fabricate, always traceable" rule.
  if (!businessName || !sourceUrl) return null;

  const emails = unique([
    ...(raw.publicEmails || []).map(normalizeEmail),
    normalizeEmail(raw.email),
  ].filter((email) => email && !isJunkEmail(email)));

  const phones = unique([
    ...(raw.publicPhones || []).map(normalizePhone),
    normalizePhone(raw.phone),
  ]);

  const website = clean(raw.website);
  const lead = {
    businessName,
    category: clean(raw.category),
    description: clean(raw.description),
    address: clean(raw.address),
    city: clean(raw.city),
    state: normalizeState(raw.state),
    zip: clean(raw.zip),
    phone: phones[0] || null,
    email: emails[0] || null,
    website: website ? website.replace(/\/+$/, '') : null,
    source: clean(raw.source) || 'usdirectory',
    sourceUrl,
    sourceId: clean(raw.sourceId),
    contactPageUrl: clean(raw.contactPageUrl),
    publicEmails: emails,
    publicPhones: phones,
    services: unique((raw.services || []).map(clean)),
    emailStatus: emails.length ? (emails.every(isValidEmail) ? 'valid' : 'invalid') : 'unknown',
    enrichmentStatus: raw.enrichmentStatus || 'not_attempted',
    enrichmentSources: unique(raw.enrichmentSources || []),
    demoData: Boolean(raw.demoData),
    possibleDuplicate: Boolean(raw.possibleDuplicate),
    duplicateReason: clean(raw.duplicateReason),
    notes: unique(raw.notes || []),
    scrapedAt: raw.scrapedAt ? new Date(raw.scrapedAt) : new Date(),
  };
  if (raw.aiCategory || raw.aiTags || raw.aiServices || raw.aiDescription) {
    lead.aiCategory = clean(raw.aiCategory);
    lead.aiServices = unique(raw.aiServices || []);
    lead.aiTags = unique(raw.aiTags || []);
    lead.aiDescription = clean(raw.aiDescription);
    lead.aiGeneratedAt = new Date();
  }
  return lead;
}

module.exports = {
  clean,
  deobfuscate,
  extractEmails,
  extractPhones,
  formatPhone,
  isJunkEmail,
  isValidEmail,
  normalizeEmail,
  normalizeLead,
  normalizePhone,
  normalizeState,
  unique,
};
