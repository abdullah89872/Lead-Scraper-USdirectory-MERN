'use strict';

/**
 * Syntax layer of the email validation pipeline.
 *
 * The actual parsing is delegated to `email-addresses`, a recursive-descent
 * RFC 5322 parser whose test suite includes the is_email corpus. Regexps are
 * only used as a cheap pre-filter and for the extra RFC 5321 length / domain
 * shape rules the parser intentionally does not enforce (it validates the
 * grammar, not deliverability).
 */

const { parseOneAddress } = require('email-addresses');

/** Cheap pre-filter so obviously broken input never reaches the parser. */
const SHAPE_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;

/** RFC 5321 §4.5.3.1.3 limits. */
const MAX_EMAIL_LEN = 254;
const MAX_LOCAL_LEN = 64;
const MAX_DOMAIN_LEN = 253;
const MAX_LABEL_LEN = 63;

/**
 * Normalise an address for validation and deduplication.
 *
 * - trims whitespace and surrounding angle brackets / quotes
 * - drops `mailto:` prefixes and trailing query strings (web-scraped noise)
 * - lower-cases the whole address (project convention: Lead.email is lowercase)
 * - converts an Unicode domain to punycode (IDNA); returns null if it cannot
 *   be represented, so the caller reports a clear syntax error
 *
 * @param {unknown} raw
 * @returns {string|null} normalised address or null when nothing usable remains
 */
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  value = value.replace(/^mailto:/i, '');
  value = value.split('?')[0];
  value = value.replace(/^[<(\"'`]+/, '').replace(/[>)\"'`.,;:]+$/, '');
  value = value.replace(/\s+/g, '');
  if (!value || !value.includes('@')) return null;
  if (value.length > MAX_EMAIL_LEN) return null;

  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).replace(/\.$/, ''); // absolute FQDN dot
  if (!local || !domain) return null;

  // IDNA: keep ASCII domains untouched, punycode the rest.
  const asciiDomain = /^[\x00-\x7F]+$/.test(domain)
    ? domain.toLowerCase()
    : domainToAscii(domain);
  if (!asciiDomain) return null;

  return `${local.toLowerCase()}@${asciiDomain}`;
}

/** Minimal IDNA helper built on WHATWG URL (no extra dependency). */
function domainToAscii(domain) {
  try {
    const url = new URL(`http://${domain.toLowerCase()}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

/** RFC 5321 domain shape: dotted labels of LDH characters, TLD not all-digits. */
function isWellFormedDomain(domain) {
  if (!domain || domain.length > MAX_DOMAIN_LEN) return false;
  if (domain.startsWith('.') || domain.endsWith('..') || !domain.includes('.')) return false;
  const labels = domain.split('.');
  if (labels.some((label) => !label || label.length > MAX_LABEL_LEN)) return false;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/**
 * Validate a (normalised) address's syntax.
 *
 * @param {string} address lower-cased `local@domain`
 * @returns {{ valid: boolean, reason: string|null, local: string|null, domain: string|null }}
 */
function checkSyntax(address) {
  const fail = (reason) => ({ valid: false, reason, local: null, domain: null });

  if (typeof address !== 'string' || !address.trim()) return fail('Address is empty');
  if (/\s/.test(address)) return fail('Address contains whitespace');
  if (address.length > MAX_EMAIL_LEN) {
    return fail(`Address is too long (${address.length} chars, max ${MAX_EMAIL_LEN})`);
  }
  if ((address.match(/@/g) || []).length !== 1) return fail('Address must contain exactly one @');

  const at = address.indexOf('@');
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (!local) return fail('Local part is empty');
  if (local.length > MAX_LOCAL_LEN) {
    return fail(`Local part is too long (${local.length} chars, max ${MAX_LOCAL_LEN})`);
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return fail('Local part has misplaced dots');
  }
  if (!isWellFormedDomain(domain)) return fail('Domain part is malformed');

  if (!SHAPE_RE.test(address)) return fail('Address contains invalid characters');

  // Real parser: the RFC 5322 grammar (quoted strings, domain literals, ...).
  // `rejectTLD` mirrors the project rule that a bare label is not a domain.
  let parsed = null;
  try {
    parsed = parseOneAddress({
      input: address,
      simple: true,
      strict: true,
      rejectTLD: true,
      rfc6532: true,
    });
  } catch {
    parsed = null;
  }
  if (!parsed) return fail('Address does not parse as RFC 5322 syntax');

  return { valid: true, reason: null, local, domain };
}

/**
 * Full syntax stage: normalise + check.
 * @param {unknown} raw
 * @returns {{ valid: boolean, address: string|null, reason: string|null, local: string|null, domain: string|null }}
 */
function check(raw) {
  const address = normalize(raw);
  if (!address) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    return {
      valid: false,
      address: null,
      reason: text ? 'Address is malformed or unusable' : 'Address is empty',
      local: null,
      domain: null,
    };
  }
  const result = checkSyntax(address);
  return { ...result, address };
}

module.exports = {
  MAX_EMAIL_LEN,
  MAX_LOCAL_LEN,
  check,
  checkSyntax,
  isWellFormedDomain,
  normalize,
};
