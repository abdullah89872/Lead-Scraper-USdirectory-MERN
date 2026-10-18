'use strict';

/**
 * Disposable / role-based / free-provider detection.
 *
 * Sources are merged and updateable without a code change:
 *   1. the bundled list in `data/disposable-domains.json`
 *   2. an optional user-supplied file (`DISPOSABLE_DOMAINS_FILE`) - either a
 *      JSON array or one domain per line, `#` comments allowed
 *   3. extra role prefixes from `EMAIL_ROLE_ADDRESSES` (comma separated)
 *
 * These are *flags*, never automatic verdicts: a disposable address is RISKY,
 * a role account keeps whatever status the other checks produce (unless
 * `EMAIL_VALIDATION_ROLE_RISKY=true`).
 */

const fs = require('fs');
const path = require('path');
const env = require('../../config/env');

const BUNDLED_FILE = path.join(__dirname, 'data', 'disposable-domains.json');

const ROLE_LOCAL_PARTS = new Set([
  'abuse',
  'admin',
  'billing',
  'contact',
  'customerservice',
  'help',
  'info',
  'inquiries',
  'jobs',
  'marketing',
  'office',
  'orders',
  'postmaster',
  'privacy',
  'reception',
  'sales',
  'security',
  'service',
  'support',
  'team',
  'webmaster',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.com.hk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'mail.com',
  'hushmail.com',
  'fastmail.com',
  'hey.com',
  'qq.com',
  '163.com',
  '126.com',
  'rambler.ru',
  'inbox.com',
  'mail.ru',
]);

let disposable = new Set();
let disposableSources = [];
let roleExtras = new Set();
let loaded = false;

function parseDomainFile(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
      }
    } catch (error) {
      throw new Error(`DISPOSABLE_DOMAINS_FILE is not valid JSON: ${error.message}`);
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim().toLowerCase())
    .filter(Boolean);
}

/** (Re)load every configured source. Called lazily and on demand. */
function reload() {
  const domains = [];
  const sources = [];

  const bundled = JSON.parse(fs.readFileSync(BUNDLED_FILE, 'utf8'));
  domains.push(...bundled);
  sources.push({ name: 'bundled', count: bundled.length });

  const extraFile = String(process.env.DISPOSABLE_DOMAINS_FILE || '').trim();
  if (extraFile) {
    const resolved = path.resolve(extraFile);
    const text = fs.readFileSync(resolved, 'utf8');
    const extra = parseDomainFile(text);
    domains.push(...extra);
    sources.push({ name: resolved, count: extra.length });
  }

  disposable = new Set(domains.map((domain) => domain.toLowerCase()));
  disposableSources = sources;

  roleExtras = new Set(
    String(process.env.EMAIL_ROLE_ADDRESSES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  loaded = true;
}

function ensureLoaded() {
  if (!loaded) reload();
}

function isDisposable(domain) {
  if (!domain) return false;
  ensureLoaded();
  return disposable.has(domain);
}

function isRoleAddress(local, domain) {
  ensureLoaded();
  const localPart = String(local || '').toLowerCase();
  if (ROLE_LOCAL_PARTS.has(localPart)) return true;
  if (roleExtras.has(localPart)) return true;
  // `sales+ops@` / `info.de@` style variants still read as role accounts.
  const base = localPart.split(/[+._-]/)[0];
  return ROLE_LOCAL_PARTS.has(base) || roleExtras.has(base);
}

function isFreeProvider(domain) {
  if (!domain) return false;
  return FREE_PROVIDERS.has(domain);
}

/** Introspection for the settings/API surface. */
function listInfo() {
  ensureLoaded();
  return {
    disposableDomains: disposable.size,
    roleLocalParts: ROLE_LOCAL_PARTS.size + roleExtras.size,
    freeProviders: FREE_PROVIDERS.size,
    sources: disposableSources,
  };
}

module.exports = {
  isDisposable,
  isFreeProvider,
  isRoleAddress,
  listInfo,
  reload,
};
