'use strict';

/**
 * Domain / DNS layer.
 *
 * - resolves MX records with a per-query timeout (never hangs the pipeline)
 * - falls back to A/AAAA (RFC 5321 implicit MX) when no MX exists
 * - distinguishes *definitive* negatives (NXDOMAIN, no records) from
 *   *temporary* failures (timeout, SERVFAIL, resolver errors). A temporary
 *   failure is NEVER treated as evidence that an address is invalid.
 * - caches results in-process with a TTL; identical concurrent lookups for
 *   the same domain share a single query.
 */

const dns = require('dns').promises;
const env = require('../../config/env');

/** Per-query timeout; `tries: 1` keeps worst-case latency bounded. */
const resolver = new dns.Resolver({
  timeout: env.validation.dns.timeoutMs,
  tries: 1,
});

/** domain -> { entry, expiresAt } */
const cache = new Map();
/** domain -> in-flight promise (dedupe concurrent lookups) */
const inflight = new Map();

const DEFINITIVE_MISSING = new Set(['ENOTFOUND', 'ENODATA']);

function classifyError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (DEFINITIVE_MISSING.has(code)) return 'missing';
  // Everything else (ETIMEOUT, ESERVFAIL, ECONNREFUSED, EAI_AGAIN, resolver
  // crashes, ...) is temporary: better UNKNOWN than a false INVALID.
  return 'temporary';
}

async function resolveWith(fn, arg) {
  try {
    return { ok: true, value: await fn(arg) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Core lookup without caching. */
async function lookupDomain(domain) {
  const mx = await resolveWith(resolver.resolveMx.bind(resolver), domain);

  if (mx.ok) {
    // RFC 7505 null MX: a single "." exchange means "this domain accepts no
    // email by design" - definitive, not a temporary condition.
    const hosts = mx.value
      .filter((record) => record && record.exchange && record.exchange !== '.')
      .map((record) => ({
        exchange: record.exchange.replace(/\.$/, '').toLowerCase(),
        priority: Number(record.priority) || 0,
      }))
      .sort((a, b) => a.priority - b.priority);

    if (mx.value.some((record) => record && record.exchange === '.') && hosts.length === 0) {
      return {
        status: 'missing',
        mxFound: false,
        mxHosts: [],
        fallbackUsed: false,
        reason: 'Domain publishes a null MX (does not accept email)',
      };
    }
    if (hosts.length > 0) {
      return { status: 'ok', mxFound: true, mxHosts: hosts, fallbackUsed: false, reason: null };
    }
    // MX list existed but was empty/invalid - fall through to A lookup.
  } else if (classifyError(mx.error) === 'missing') {
    // Domain does not exist at all: no point querying A/AAAA.
    return {
      status: 'missing',
      mxFound: false,
      mxHosts: [],
      fallbackUsed: false,
      reason: 'Domain does not exist (NXDOMAIN)',
    };
  }

  // No usable MX: try the A/AAAA fallback (implicit MX, RFC 5321 §5.1).
  const a4 = await resolveWith(resolver.resolve4.bind(resolver), domain);
  if (a4.ok && a4.value && a4.value.length) {
    return { status: 'ok', mxFound: false, mxHosts: [{ exchange: domain, priority: 0 }], fallbackUsed: true, reason: null };
  }
  const a6 = await resolveWith(resolver.resolve6.bind(resolver), domain);
  if (a6.ok && a6.value && a6.value.length) {
    return { status: 'ok', mxFound: false, mxHosts: [{ exchange: domain, priority: 0 }], fallbackUsed: true, reason: null };
  }

  const mxDefinitiveMissing = !mx.ok && classifyError(mx.error) === 'missing';
  const a4Missing = !a4.ok && classifyError(a4.error) === 'missing';
  const a6Missing = !a6.ok && classifyError(a6.error) === 'missing';

  if (mxDefinitiveMissing && a4Missing && a6Missing) {
    return {
      status: 'missing',
      mxFound: false,
      mxHosts: [],
      fallbackUsed: false,
      reason: 'Domain does not exist (NXDOMAIN)',
    };
  }
  if (mx.ok) {
    return {
      status: 'missing',
      mxFound: false,
      mxHosts: [],
      fallbackUsed: false,
      reason: 'Domain has no MX or A/AAAA records and cannot receive email',
    };
  }

  // At least one query failed for a non-definitive reason.
  return {
    status: 'temporary',
    mxFound: false,
    mxHosts: [],
    fallbackUsed: false,
    reason: 'DNS lookup failed temporarily',
  };
}

/**
 * Check a domain with caching.
 *
 * @param {string} domain normalised (lower-case, IDNA, no trailing dot)
 */
async function checkDomain(domain) {
  const cached = cache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return { domain, ...cached.entry, fromCache: true };
  }

  const pending = inflight.get(domain);
  if (pending) {
    const entry = await pending;
    return { domain, ...entry, fromCache: false };
  }

  const promise = lookupDomain(domain)
    .then((entry) => {
      // Temporary failures get a short TTL only; definitive answers live
      // longer (DNS records themselves have much longer TTLs).
      const ttl =
        entry.status === 'temporary'
          ? env.validation.dns.negativeCacheTtlMs
          : env.validation.dns.cacheTtlMs;
      pruneCache();
      cache.set(domain, { entry, expiresAt: Date.now() + ttl });
      return entry;
    })
    .finally(() => {
      inflight.delete(domain);
    });

  inflight.set(domain, promise);
  const entry = await promise;
  return { domain, ...entry, fromCache: false };
}

/** Drop cached DNS answers (tests / manual refresh). */
function clearCache() {
  cache.clear();
}

/** Size guard so hostile input cannot grow the cache unbounded. */
function pruneCache(maxEntries = 20000) {
  if (cache.size < maxEntries) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function cacheStats() {
  return { size: cache.size, inflight: inflight.size };
}

module.exports = { cacheStats, checkDomain, clearCache };
