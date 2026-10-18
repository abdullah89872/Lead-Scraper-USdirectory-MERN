'use strict';

/**
 * SMTP recipient verification (RCPT-only).
 *
 * Built on `smtp-client` (nodemailer-adjacent, promisified SMTP protocol
 * client): we drive the protocol explicitly - connect -> EHLO -> optional
 * STARTTLS -> MAIL FROM -> RCPT TO -> QUIT - and NEVER issue DATA or AUTH,
 * so no message is ever transmitted and no credentials are involved.
 *
 * Honest limitations (also surfaced in the README):
 *   - major providers block or greylist RCPT probes -> 'blocked'/'temp_failed'
 *   - some servers accept every recipient (catch-all) -> acceptance is never
 *     treated as proof of a real mailbox by itself
 *   - SMTP acceptance alone cannot guarantee deliverability
 *
 * A verification `session` collects statistics and remembers domains where a
 * provider restriction was detected so the rest of the batch defers instead
 * of hammering the server (`stop_on_provider_restriction`).
 */

const crypto = require('crypto');
const { SMTPClient } = require('smtp-client');
const env = require('../../config/env');
const logger = require('../../config/logger');

const RESULTS = {
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  INCONCLUSIVE: 'inconclusive',
  BLOCKED: 'blocked',
  TEMP_FAILED: 'temp_failed',
  UNAVAILABLE: 'unavailable',
  NOT_ATTEMPTED: 'not_attempted',
  ERROR: 'error',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mask a local part so logs never carry full addresses. */
function maskEmail(email) {
  const at = String(email).lastIndexOf('@');
  if (at < 2) return '***';
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

const POLICY_RE = /policy|relay|denied|blocked|not allowed|not permitted|spam|blacklist|rejection|reputation|access denied|forbidden/i;
const MAILBOX_RE = /user unknown|unknown user|no such user|does not exist|doesn't exist|recipient.*(rejected|refused|not found|unavailable)|mailbox (unavailable|not found|full)|invalid recipient|address rejected|no mailbox/i;

function isReplyError(error) {
  return Boolean(error) && error.name === 'SMTPResponseError';
}

function describeReply(error) {
  const code = String(error.code || '500');
  const enhanced = error.enhancedCode
    ? Array.isArray(error.enhancedCode)
      ? error.enhancedCode.join('.')
      : String(error.enhancedCode)
    : null;
  const message = String(error.message || '').slice(0, 300);
  return { code, enhanced, message };
}

/** Classify a MAIL FROM / RCPT TO rejection into a result category. */
function classifyRejection(error, stage) {
  const { code, enhanced, message } = describeReply(error);
  const permanent = code.startsWith('5');
  const text = `${enhanced || ''} ${message}`;

  if (!permanent) return { result: RESULTS.TEMP_FAILED, code, enhanced, message };
  if (/^5\.7/.test(enhanced || '') || POLICY_RE.test(text)) {
    return { result: RESULTS.BLOCKED, code, enhanced, message };
  }
  if (stage === 'rcpt' && (/^5\.1/.test(enhanced || '') || MAILBOX_RE.test(text))) {
    return { result: RESULTS.REJECTED, code, enhanced, message };
  }
  // A permanent rejection without explicit mailbox evidence (possible for an
  // unprobed envelope sender, greylisting appliances, ...) is inconclusive:
  // never "invalid" on ambiguous evidence.
  return { result: RESULTS.INCONCLUSIVE, code, enhanced, message };
}

/** Classify socket / TLS / timeout failures. */
function classifyTransportError(error) {
  const code = String(error?.code || error?.errno || '').toUpperCase();
  const message = String(error?.message || '');
  if (
    ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code) ||
    /certificate|self.signed|altname/i.test(message)
  ) {
    return { result: RESULTS.UNAVAILABLE, reason: 'TLS certificate verification failed' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { result: RESULTS.UNAVAILABLE, reason: 'MX hostname could not be resolved' };
  }
  if (/timed out|timeout/i.test(message)) {
    return { result: RESULTS.TEMP_FAILED, reason: 'SMTP command timed out' };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT'].includes(code)) {
    return { result: RESULTS.UNAVAILABLE, reason: `Connection failed (${code})` };
  }
  if (/Socket has closed/i.test(message)) {
    return { result: RESULTS.TEMP_FAILED, reason: 'Connection closed by server' };
  }
  return { result: RESULTS.ERROR, reason: message.slice(0, 200) || 'Unexpected SMTP failure' };
}

// ---- Connection pacing ------------------------------------------------------

const cfg = env.validation.smtp;

let activeConnections = 0;
let nextSlotAt = 0;

function acquireSlot() {
  if (activeConnections < cfg.maxConcurrency) {
    activeConnections += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const wait = () => {
      if (activeConnections < cfg.maxConcurrency) {
        activeConnections += 1;
        resolve();
      } else {
        setTimeout(wait, 25 + Math.floor(Math.random() * 50));
      }
    };
    wait();
  });
}

function releaseSlot() {
  activeConnections = Math.max(0, activeConnections - 1);
}

/** Reserve the next allowed connection time (atomic: no awaits inside). */
function reserveSlotTime() {
  const at = Math.max(Date.now(), nextSlotAt);
  nextSlotAt = at + cfg.minDelayMs;
  return at;
}

/** Per-domain serialisation: never two parallel sessions against one MX. */
const domainQueues = new Map();
function withDomainLock(domain, fn) {
  const previous = domainQueues.get(domain) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  domainQueues.set(domain, tail);
  tail.then(() => {
    if (domainQueues.get(domain) === tail) domainQueues.delete(domain);
  });
  return run;
}

// ---- Sessions ---------------------------------------------------------------

/** A session tracks per-batch state: restrictions, circuit breaker, stats. */
function createSession() {
  const session = {
    restrictedDomains: new Set(),
    stoppedReason: null,
    consecutiveRestrictions: 0,
    stats: {
      attempted: 0,
      accepted: 0,
      rejected: 0,
      inconclusive: 0,
      blocked: 0,
      tempFailed: 0,
      unavailable: 0,
      notAttempted: 0,
      error: 0,
      catchAll: 0,
      tlsUpgraded: 0,
    },
  };
  return session;
}

function noteResult(session, domain, outcome) {
  // "attempted" counts checks that actually entered the SMTP conversation;
  // deferred/disabled checks are tracked separately as notAttempted.
  if (outcome.result !== RESULTS.NOT_ATTEMPTED) session.stats.attempted += 1;
  switch (outcome.result) {
    case RESULTS.ACCEPTED:
      session.stats.accepted += 1;
      session.consecutiveRestrictions = 0;
      if (outcome.catchAll) session.stats.catchAll += 1;
      break;
    case RESULTS.REJECTED:
      session.stats.rejected += 1;
      session.consecutiveRestrictions = 0;
      break;
    case RESULTS.INCONCLUSIVE:
      session.stats.inconclusive += 1;
      session.consecutiveRestrictions = 0;
      break;
    case RESULTS.BLOCKED:
      session.stats.blocked += 1;
      session.consecutiveRestrictions += 1;
      if (cfg.stopOnProviderRestriction && domain) {
        session.restrictedDomains.add(domain);
      }
      // Repeated blocks trip a global circuit breaker so the batch stops
      // creating connections entirely instead of burning the IP's reputation.
      if (session.consecutiveRestrictions >= 5 && !session.stoppedReason) {
        session.stoppedReason = 'provider restrictions detected repeatedly; remaining SMTP checks deferred';
        logger.warn({ domains: session.restrictedDomains.size }, 'smtp circuit breaker engaged');
      }
      break;
    case RESULTS.TEMP_FAILED:
      session.stats.tempFailed += 1;
      session.consecutiveRestrictions = 0;
      break;
    case RESULTS.UNAVAILABLE:
      session.stats.unavailable += 1;
      session.consecutiveRestrictions = 0;
      break;
    case RESULTS.ERROR:
      session.stats.error += 1;
      break;
    case RESULTS.NOT_ATTEMPTED:
    default:
      session.stats.notAttempted += 1;
      break;
  }
}

// ---- Single verification ----------------------------------------------------

const RETRYABLE = new Set([RESULTS.TEMP_FAILED, RESULTS.UNAVAILABLE]);

function safeServername(host) {
  // SNI requires a hostname; skip it for literal addresses.
  return /^[0-9.]+$/.test(host) || host.includes(':') ? undefined : host;
}

/**
 * One SMTP conversation against one MX host.
 * Returns `{ decided, outcome }`:
 *   decided=true  -> a permanent answer was reached; stop trying hosts
 *   decided=false -> transport-level failure; try the next host / retry
 */
async function attemptHost(host, email, domain, session) {
  const port = Number(host.port) || cfg.port || 25;
  const exchange = host.exchange;
  const client = new SMTPClient({
    host: exchange,
    port,
    timeout: cfg.timeoutMs,
    // Certificate verification stays ON: we never downgrade to plaintext
    // after a certificate failure.
    rejectUnauthorized: true,
    servername: safeServername(exchange),
  });

  try {
    // 1. Greeting (SMTPClient.connect consumes the server's 220 banner).
    try {
      await client.connect({ timeout: cfg.timeoutMs });
    } catch (error) {
      if (isReplyError(error)) {
        const { code, message } = describeReply(error);
        return {
          decided: false,
          outcome: {
            result: code.startsWith('4') ? RESULTS.TEMP_FAILED : RESULTS.UNAVAILABLE,
            reason: `Server greeting rejected (${code})`,
            code,
            enhanced: null,
            message,
          },
        };
      }
      return { decided: false, outcome: { ...classifyTransportError(error), code: null, enhanced: null, message: null } };
    }

    // 2. EHLO (falls back to HELO inside smtp-client).
    await client.greet({ timeout: cfg.timeoutMs });

    // 3. Opportunistic STARTTLS with certificate verification (RFC 3207).
    let tls = false;
    if (client.hasExtension('STARTTLS')) {
      const code = await client.write('STARTTLS\r\n', { timeout: cfg.timeoutMs });
      if (code === '220') {
        try {
          await client.negotiateTLS({
            timeout: cfg.timeoutMs,
            rejectUnauthorized: true,
            servername: safeServername(exchange),
          });
          tls = true;
          session.stats.tlsUpgraded += 1;
          await client.greet({ timeout: cfg.timeoutMs }); // re-EHLO after upgrade
        } catch (error) {
          const classified = classifyTransportError(error);
          // Certificates problems are host-specific: try the next MX instead
          // of retrying the same one, but never fall back to plaintext.
          return { decided: false, outcome: { ...classified, code: null, enhanced: null, message: null, tls } };
        }
      } else if (code.startsWith('4')) {
        return {
          decided: false,
          outcome: { result: RESULTS.TEMP_FAILED, reason: `STARTTLS deferred (${code})`, code, enhanced: null, message: null },
        };
      } else {
        return {
          decided: false,
          outcome: { result: RESULTS.UNAVAILABLE, reason: `STARTTLS rejected (${code})`, code, enhanced: null, message: null },
        };
      }
    } else if (cfg.requireTls) {
      return {
        decided: false,
        outcome: { result: RESULTS.UNAVAILABLE, reason: 'STARTTLS not offered but EMAIL_SMTP_REQUIRE_TLS=true', code: null, enhanced: null, message: null },
      };
    }

    // 4. MAIL FROM - envelope sender only; no AUTH, no DATA, ever.
    try {
      await client.mail({ from: cfg.envelopeFrom, timeout: cfg.timeoutMs });
    } catch (error) {
      if (isReplyError(error)) {
        return { decided: true, outcome: { ...classifyRejection(error, 'mail'), mx: exchange, tls } };
      }
      const classified = classifyTransportError(error);
      return { decided: false, outcome: { ...classified, code: null, enhanced: null, message: null, mx: exchange, tls } };
    }

    // 5. RCPT TO - the recipient verification itself.
    let catchAll = null;
    try {
      await client.rcpt({ to: email, timeout: cfg.timeoutMs });
    } catch (error) {
      if (isReplyError(error)) {
        const outcome = { ...classifyRejection(error, 'rcpt'), mx: exchange, tls, catchAll: null };
        return { decided: !RETRYABLE.has(outcome.result), outcome };
      }
      const classified = classifyTransportError(error);
      return { decided: false, outcome: { ...classified, code: null, enhanced: null, message: null, mx: exchange, tls } };
    }

    // 6. Optional catch-all probe (same session, unguessable local part).
    if (cfg.catchAllProbe) {
      const probe = `${crypto.randomBytes(16).toString('hex')}@${domain}`;
      try {
        await client.rcpt({ to: probe, timeout: cfg.timeoutMs });
        catchAll = true;
      } catch (error) {
        // A permanent probe rejection disproves catch-all; a temporary one
        // leaves it unknown. Transport errors also leave it unknown.
        catchAll =
          isReplyError(error) &&
          classifyRejection(error, 'rcpt').result !== RESULTS.TEMP_FAILED
            ? false
            : null;
      }
    }

    return { decided: true, outcome: { result: RESULTS.ACCEPTED, catchAll, mx: exchange, tls, code: null, enhanced: null, message: null } };
  } finally {
    // QUIT when possible, destroy otherwise - never leave sockets dangling.
    try {
      await client.quit({ timeout: 2000 });
    } catch {
      try {
        await client.close({ timeout: 1000 });
      } catch {
        /* socket already gone */
      }
    }
  }
}

// ---- Public API -------------------------------------------------------------

function deferred(session, reason) {
  const outcome = { result: RESULTS.NOT_ATTEMPTED, reason, code: null, enhanced: null, message: null, mx: null, tls: false, catchAll: null };
  return outcome;
}

/**
 * Verify one recipient over SMTP (RCPT-only, no message is ever sent).
 *
 * @param {{email: string, domain: string,
 *   mxHosts: Array<{exchange: string, priority?: number, port?: number}>}} target
 * @param {object} [session] shared session from `createSession()`
 * @returns {Promise<object>} outcome:
 *   { result, catchAll, tls, mx, code, enhanced, message, reason, retries }
 */
async function verifyRecipient(target, session = createSession()) {
  const { email, domain, mxHosts } = target;

  if (!cfg.enabled) {
    return noteOut(session, domain, deferred(session, 'SMTP verification is disabled (EMAIL_SMTP_ENABLED=false)'));
  }
  if (session.stoppedReason) {
    return noteOut(session, domain, deferred(session, session.stoppedReason));
  }
  if (session.restrictedDomains.has(domain)) {
    return noteOut(
      session,
      domain,
      deferred(session, 'A provider restriction was detected for this domain earlier in the run')
    );
  }
  if (!Array.isArray(mxHosts) || mxHosts.length === 0) {
    return noteOut(session, domain, deferred(session, 'No mail exchanger available for the domain'));
  }

  const hosts = mxHosts.slice(0, cfg.maxMxTries);

  const outcome = await withDomainLock(domain, async () => {
    let last = null;
    let retries = 0;

    for (let attempt = 0; attempt <= cfg.retryCount; attempt += 1) {
      await acquireSlot();
      try {
        // Connection pacing: reserve the next allowed slot (respect_server_limits).
        const slotAt = reserveSlotTime();
        const waitMs = slotAt - Date.now();
        if (cfg.respectServerLimits && waitMs > 0) await sleep(waitMs);

        last = null;
        for (const host of hosts) {
          // eslint-disable-next-line no-await-in-loop
          const round = await attemptHost(host, email, domain, session);
          last = round.outcome;
          if (round.decided) break;
        }
      } finally {
        releaseSlot();
      }

      if (!last) last = { result: RESULTS.ERROR, reason: 'No SMTP attempt was made' };
      const retryable =
        RETRYABLE.has(last.result) && !/certificate/i.test(String(last.reason || ''));
      if (!retryable || attempt >= cfg.retryCount) break;

      retries += 1;
      // Exponential backoff with jitter before the next attempt.
      const backoff = Math.round(cfg.retryBackoffMs * 2 ** attempt * (0.75 + Math.random() * 0.75));
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoff);
    }

    return { ...last, retries };
  });

  return noteOut(session, domain, outcome);
}

function noteOut(session, domain, outcome) {
  noteResult(session, domain, outcome);
  return outcome;
}

module.exports = {
  RESULTS,
  createSession,
  maskEmail,
  verifyRecipient,
};
