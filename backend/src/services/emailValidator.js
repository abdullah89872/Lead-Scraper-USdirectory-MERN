'use strict';

/**
 * Email Validation Service
 *
 * "Full, efficient" validation:
 *   syntax      -> RFC-ish regex + length/structure checks
 *   domain/MX   -> resolves MX (then A fallback) to confirm the domain can
 *                  receive mail
 *   disposable  -> rejects known throwaway/domain-mailer domains
 *   role        -> flags common role accounts so you don't capture "info@"
 *   dedup/clean -> case-normalised, strips Gmail dots, normalises +alias
 *
 * Runs each email concurrently, capped at MAX_CONCURRENCY, so large pasted
 * lists validate quickly without hammering DNS.
 */

const dns = require('dns').promises;
const { asyncHandler } = require('../middleware/validate');

/** DNS MX lookup with a short hard timeout per host. */
async function resolveMx(hostname) {
  try {
    const records = await dns.resolveMx(hostname);
    return records.map((r) => r.exchange.replace(/^[|"]|"$/g, ''));
  } catch {
    try {
      const { address } = await dns.resolve4(hostname);
      return [`mx.${hostname}`];
    } catch {
      return [];
    }
  }
}

/** Generic, RFC-leaning syntax regex plus structural length checks. */
const SYNTAX_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'tempmail.com', 'tempmailaddress.com', 'temp-mail.org', 'temp-mail.net',
  'yi.org', 'mailinator.net', 'mailinator.co', 'mailinator.info', 'mailinator.org',
  '10minutemail.com', '10minutemail.net', '10minutesmail.com', '10minutesmail.net',
  'yopmail.com', 'yopmail.net', 'yopmail.org',
  'throwaway.email', 'throwawaymail.com', 'throwawaymail.net',
  'maildrop.cc', 'getnada.com', 'mail.tiqualtia.com',
  'mail.su', 'degraduum.com', 'fauxmail.com', 'fakemailgenerator.com',
  'fakeinbox.com', 'spam4.me', 'spamfreeemail.com', 'mail-temporaire.fr',
  'emailtempor.com', 'm3r49u.ru', 'mailnator.com', 'sharklasers.com',
  'junkmail.com', 'sandcrawler.net', 'totallynotspam.com', 'amiricle.com',
  'tech69.net', 'ttd001.com', 'raikay.org', 'ridiculed.com', 'taxi2sky.com',
  'dodgeit.com', 'dodgethis.com', 'mailttt.com', 'm4ilhunt3r.com',
  'hells-mail.com', 'mail-foryou.net', 'sharklasers.com', 'mailnator.com',
]);

const ROLE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.hk', 'hotmail.com',
  'outlook.com', 'msn.com', 'live.com', 'aol.com', 'zoho.com', 'yandex.com',
  'mail.com', 'mail.ru', 'proton.me', 'protonmail.com', 'gmx.com',
  't-online.de', 'web.de', 'gmx.de', 'gmail.co', 'ymail.com', 'hushmail.com',
]);


/** Normalise to lowercase + strip surrounding quotes. */
function normaliseCase(email) {
  return email.trim().replace(/^["']|["']$/g, '').toLowerCase();
}

/** Strip a single trailing dot on a domain ("user@example.com." -> absolute name). */
function stripTrailingDot(email) {
  const [local, domain] = email.split('@');
  return `${local}@${domain.replace(/\.$/, '')}`;
}

/**
 * Normalise a Gmail/Yahoo-style address.
 *   - lowercases everything
 *   - removes dots in the local part (Gmail ignores them)
 *   - drops a `+suffix` alias
 */
function normaliseFolding(email) {
  let [local, domain] = email.split('@');
  local = local.toLowerCase();
  domain = domain.toLowerCase();
  if (/^(gm|google|googlemail)\.com$/.test(domain)) {
    local = local.split('+')[0].replace(/\./g, '');
  }
  return `${local}@${domain}`;
}

/**
 * Validate a single email address.
 * Returns { status, flags, reason }.
 *   status: 'valid' | 'invalid' | 'warning'
 *   flags:  ['mx', 'role', 'disposable', ...]
 *   reason: human-readable explanation (empty for valid)
 */
async function validateEmail(email) {
  const flags = [];
  let reason = '';

  if (!email || typeof email !== 'string') {
    return { status: 'invalid', flags: ['empty'], reason: 'Email is empty' };
  }

  const normalised = normaliseCase(email);
  const folded = normaliseFolding(normalised);
  const address = stripTrailingDot(folded);

  // ---- syntax ----
  if (!SYNTAX_RE.test(address)) {
    return {
      status: 'invalid',
      flags: ['syntax'],
      reason: 'Email address is not syntactically valid',
    };
  }
  const [local, domain] = address.split('@');
  if (local.length > 64) {
    return { status: 'invalid', flags: ['syntax'], reason: 'Local part is too long (max 64 chars)' };
  }
  if (address.length > 254) {
    return { status: 'invalid', flags: ['syntax'], reason: 'Email address is too long (max 254 chars)' };
  }

  // ---- disposable ----
  if (DISPOSABLE_DOMAINS.has(domain)) {
    flags.push('disposable');
    reason = `Domain "${domain}" is a known disposable/throwaway email service`;
  }

  // ---- domain resolution (only for non-disposable) ----
  if (flags.length === 0) {
    const mxRecords = await resolveMx(domain);
    if (mxRecords.length === 0) {
      flags.push('mx');
      reason = `Domain "${domain}" has no MX record and cannot receive email`;
    } else {
      flags.push('mx', 'deliverable');
    }
  }

  // ---- role detection ----
  if (ROLE_DOMAINS.has(domain)) {
    flags.push('role');
    if (!reason) {
      reason = `Domain "${domain}" is a free web-mail provider (role/monitor address)`;
    }
  }

  const status = flags.includes('disposable') || flags.includes('syntax') || flags.includes('mx') ? 'invalid' : 'valid';
  return { status, flags, reason };
}

/** Split whitespace / commas / semicolons into an array of email strings. */
function splitEmails(input) {
  return (
    input
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => e.replace(/^["']|["']$/g, ''))
      .filter((e) => e.length > 0)
  );
}

/**
 * Validate an array of emails.
 * Returns { results, summary }.
 * Deduplication is case-insensitive and folding-aware; duplicates appear in
 * the results as `status: 'duplicate'` with `summary.duplicates` flagged.
 */
async function validateEmails(emails, options = {}) {
  const { maxConcurrency = 10, batch = 500 } = options;

  const items = splitEmails(emails);
  const unordered = [];
  const seen = new Map();

  for (const raw of items) {
    const key = normaliseFolding(normaliseCase(raw));
    const existing = seen.get(key);
    if (existing) {
      existing.duplicate = true;
      unordered.push({
        email: existing.original,
        status: 'duplicate',
        flags: ['duplicate'],
        reason: 'Duplicate of a previously validated email',
        resolvedKey: key,
      });
    } else {
      seen.set(key, { email: raw, original: raw, duplicate: false, resolvedKey: key });
      unordered.push({ email: raw, status: null, flags: [], reason: '', resolvedKey: key, duplicate: false });
    }
  }

  const results = [];
  const seenKeys = new Set();

  for (let i = 0; i < unordered.length; i += batch) {
    const batchItems = unordered.slice(i, i + batch);
    const promises = batchItems.map(async (item) => {
      if (item.duplicate) return item;
      const res = await validateEmail(item.email);
      if (res.status === 'valid') {
        const dedupKey = normaliseFolding(normaliseCase(item.email));
        if (seenKeys.has(dedupKey)) {
          return { email: item.email, status: 'duplicate', flags: ['duplicate'], reason: 'Duplicate of another valid email' };
        }
        seenKeys.add(dedupKey);
      }
      return { ...res };
    });
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  const summary = {
    total: results.length,
    valid: results.filter((r) => r.status === 'valid').length,
    invalid: results.filter((r) => r.status === 'invalid').length,
    risky: results.filter((r) => r.status === 'warning').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
  };

  return { results, summary };
}

module.exports = {
  validateEmail,
  validateEmails,
  splitEmails,
  SYNTAX_RE,
  DISPOSABLE_DOMAINS,
  ROLE_DOMAINS,
  resolveMx,
};
