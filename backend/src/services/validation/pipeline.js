'use strict';

/**
 * Email validation pipeline.
 *
 * Stages run in sequence per address:
 *   1. Syntax      (normalize + RFC 5322 parse)
 *   2. Domain/DNS  (MX, then A/AAAA fallback; temporary != invalid)
 *   3. Lists       (disposable, role-based, free-provider flags)
 *   4. SMTP        (RCPT-only, advisory; never labels valid on acceptance alone)
 *
 * Each stage appends its evidence to a shared result object. The overall status
 * is computed last from the collected evidence and the configured policy.
 */

const syntax = require('./syntax');
const dns = require('./dns');
const lists = require('./lists');
const smtp = require('./smtp');
const env = require('../../config/env');
const logger = require('../../config/logger');

const VALID_POLICY_DNS = 'dns';
const VALID_POLICY_SMTP = 'smtp';

const STATUS_VALID = 'VALID';
const STATUS_INVALID = 'INVALID';
const STATUS_RISKY = 'RISKY';
const STATUS_UNKNOWN = 'UNKNOWN';
const STATUS_PENDING = 'PENDING';
const STATUS_ERROR = 'ERROR';

const ROLE_PREFIXES = new Set([
  'abuse', 'admin', 'billing', 'contact', 'customerservice', 'help', 'info',
  'inquiries', 'jobs', 'marketing', 'office', 'orders', 'postmaster', 'privacy',
  'reception', 'sales', 'security', 'service', 'support', 'team', 'webmaster',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.com.hk',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'mail.ru', 'proton.me', 'protonmail.com', 'protonmail.ch', 'gmx.com', 'gmx.de',
  'gmx.net', 'web.de', 't-online.de', 'mail.com', 'hushmail.com', 'fastmail.com',
  'hey.com', 'qq.com', '163.com', '126.com', 'rambler.ru', 'inbox.com',
]);

/** Normalize + split raw input into deduplicated addresses, preserving order. */
function parseInput(input) {
  if (typeof input === 'string') {
    return input.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input.map((item) => (typeof item === 'string' ? item : String(item?.email || '')).trim()).filter(Boolean);
  }
  return [];
}

/** Per-address pipeline result. */
function newResult(raw, address) {
  return {
    raw,
    address: address || null,
    normalized: address || null,
    syntaxValid: false,
    domainExists: false,
    mxFound: false,
    fallbackUsed: false,
    disposable: false,
    roleBased: false,
    freeProvider: false,
    catchAll: null,
    smtpAttempted: false,
    smtpResult: smtp.RESULTS.NOT_ATTEMPTED,
    smtpCode: null,
    smtpEnhanced: null,
    smtpMessage: null,
    status: STATUS_PENDING,
    confidence: 0,
    reason: 'Validation has not started',
    updatedAt: null,
  };
}

/**
 * Run the full pipeline for one address.
 *
 * @param {string} raw original input value
 * @param {object} [session] SMTP session (shared across a batch)
 * @returns {Promise<object>} validation result
 */
async function validateAddress(raw, session = smtp.createSession()) {
  const result = newResult(raw);

  try {
    // ---- Stage 1: Syntax ---------------------------------------------------
    const syntaxResult = syntax.check(raw);
    result.address = syntaxResult.address;
    result.normalized = syntaxResult.address;
    result.syntaxValid = Boolean(syntaxResult.valid);
    if (!syntaxResult.valid) {
      result.status = STATUS_INVALID;
      result.reason = syntaxResult.reason || 'Invalid email syntax';
      result.confidence = 100;
      result.updatedAt = new Date();
      return result;
    }
    result.domain = syntaxResult.domain;
    result.local = syntaxResult.local;

    // ---- Stage 2: Domain / DNS --------------------------------------------
    const domainResult = await dns.checkDomain(result.domain);
    result.domainExists = domainResult.status === 'ok';
    result.mxFound = Boolean(domainResult.mxFound);
    result.fallbackUsed = Boolean(domainResult.fallbackUsed);
    if (domainResult.status === 'missing') {
      result.status = STATUS_INVALID;
      result.reason = domainResult.reason || 'Domain cannot receive email';
      result.confidence = 95;
      result.updatedAt = new Date();
      return result;
    }
    if (domainResult.status === 'temporary') {
      result.reason = domainResult.reason || 'DNS lookup failed temporarily';
    }

    // ---- Stage 3: Disposable / role / free-provider ------------------------
    result.disposable = lists.isDisposable(result.domain);
    result.roleBased = lists.isRoleAddress(result.local || '', result.domain);
    result.freeProvider = lists.isFreeProvider(result.domain);

    // ---- Stage 4: SMTP -----------------------------------------------------
    if (env.validation.smtp.enabled && domainResult.mxHosts && domainResult.mxHosts.length) {
      const smtpTarget = {
        email: result.address,
        domain: result.domain,
        mxHosts: domainResult.mxHosts.map((h) => ({ exchange: h.exchange, priority: h.priority, port: env.validation.smtp.port })),
      };
      const smtpOutcome = await smtp.verifyRecipient(smtpTarget, session);
      result.smtpAttempted = smtpOutcome.result !== smtp.RESULTS.NOT_ATTEMPTED;
      result.smtpResult = smtpOutcome.result;
      result.smtpCode = smtpOutcome.code;
      result.smtpEnhanced = smtpOutcome.enhanced;
      result.smtpMessage = smtpOutcome.message;
      result.catchAll = smtpOutcome.catchAll;
    }

    // ---- Overall status ----------------------------------------------------
    computeStatus(result, domainResult);
  } catch (error) {
    logger.error({ err: error.message, raw }, 'validation pipeline error');
    result.status = STATUS_ERROR;
    result.reason = 'Internal processing failure';
    result.confidence = 0;
  }

  result.updatedAt = new Date();
  return result;
}

/**
 * Compute the overall status and confidence from collected evidence.
 *
 * Rules:
 *   - INVALID: syntax fail, domain missing, or explicit SMTP mailbox rejection.
 *   - RISKY: disposable domain (always), or role-based when roleAsRisky=true.
 *   - UNKNOWN: DNS temporary failure, SMTP blocked/inconclusive/temp_failed,
 *              catch-all suspected, or SMTP disabled with only DNS evidence.
 *   - VALID: syntax + domain OK, and (policy=dns) or (policy=smtp && accepted).
 *              SMTP acceptance alone never guarantees deliverability.
 */
function computeStatus(result, domainResult) {
  const cfg = env.validation;
  const policy = cfg.validPolicy === VALID_POLICY_SMTP ? VALID_POLICY_SMTP : VALID_POLICY_DNS;

  // Strong negative evidence first.
  if (!result.syntaxValid) {
    result.status = STATUS_INVALID;
    result.confidence = 100;
    result.reason = result.reason || 'Invalid email syntax';
    return;
  }
  if (domainResult.status === 'missing') {
    result.status = STATUS_INVALID;
    result.confidence = 95;
    result.reason = result.reason || 'Domain cannot receive email';
    return;
  }
  if (result.smtpResult === smtp.RESULTS.REJECTED) {
    result.status = STATUS_INVALID;
    result.confidence = 90;
    result.reason = result.reason || 'Recipient explicitly rejected by mail server';
    return;
  }

  // Disposable is always a risk flag regardless of other evidence.
  if (result.disposable) {
    result.status = STATUS_RISKY;
    result.confidence = 85;
    result.reason = result.reason || 'Disposable or temporary email domain';
    return;
  }

  // Role-based handling.
  if (result.roleBased) {
    if (cfg.roleAsRisky) {
      result.status = STATUS_RISKY;
      result.confidence = 75;
      result.reason = result.reason || 'Role-based address (info@, sales@, support@, ...)';
      return;
    }
    // Flag only; status decided by the remaining checks below.
  }

  // DNS temporary failure makes the verdict inconclusive.
  if (domainResult.status === 'temporary') {
    result.status = STATUS_UNKNOWN;
    result.confidence = 40;
    result.reason = result.reason || 'DNS lookup failed temporarily';
    return;
  }

  // SMTP outcomes (only when SMTP is enabled and was attempted).
  if (cfg.smtp.enabled && result.smtpAttempted) {
    if (result.smtpResult === smtp.RESULTS.ACCEPTED) {
      if (policy === VALID_POLICY_SMTP && result.catchAll) {
        result.status = STATUS_UNKNOWN;
        result.confidence = 45;
        result.reason = 'SMTP server accepts arbitrary recipients; mailbox could not be confirmed';
        return;
      }
      if (policy === VALID_POLICY_SMTP) {
        result.status = STATUS_VALID;
        result.confidence = 70;
        result.reason = 'Syntax, domain and SMTP checks passed';
      } else {
        result.status = STATUS_VALID;
        result.confidence = 80;
        result.reason = 'Syntax and domain checks passed';
      }
    } else if (result.smtpResult === smtp.RESULTS.BLOCKED || result.smtpResult === smtp.RESULTS.TEMP_FAILED || result.smtpResult === smtp.RESULTS.INCONCLUSIVE) {
      result.status = STATUS_UNKNOWN;
      result.confidence = 50;
      result.reason = `SMTP verification ${result.smtpResult} - result inconclusive`;
    } else if (result.smtpResult === smtp.RESULTS.UNAVAILABLE || result.smtpResult === smtp.RESULTS.NOT_ATTEMPTED) {
      result.status = STATUS_UNKNOWN;
      result.confidence = 55;
      result.reason = 'SMTP verification unavailable or not attempted';
    } else {
      result.status = STATUS_UNKNOWN;
      result.confidence = 35;
      result.reason = `SMTP verification ${result.smtpResult || 'failed'} - result inconclusive`;
    }
    return;
  }

  if (policy === VALID_POLICY_SMTP) {
    result.status = STATUS_UNKNOWN;
    result.confidence = 35;
    result.reason = 'SMTP verification was not completed; recipient could not be confirmed';
    return;
  }

  // SMTP disabled or no MX hosts: rely on DNS evidence.
  if (domainResult.status === 'ok' && result.mxFound) {
    result.status = STATUS_VALID;
    result.confidence = policy === VALID_POLICY_SMTP ? 60 : 80;
    result.reason = 'Syntax and domain checks passed';
    if (cfg.smtp.enabled && !result.smtpAttempted) {
      result.reason += '; SMTP not attempted';
      result.confidence = 55;
    }
    return;
  }

  // Fallback (A/AAAA only) - still usable but less certain.
  if (domainResult.status === 'ok' && result.fallbackUsed) {
    result.status = STATUS_VALID;
    result.confidence = policy === VALID_POLICY_SMTP ? 55 : 70;
    result.reason = 'Syntax and A/AAAA records found (no MX)';
    return;
  }

  result.status = STATUS_UNKNOWN;
  result.confidence = 30;
  result.reason = result.reason || 'Insufficient evidence to validate';
}

function summaryOf(results) {
  return {
    total: results.length,
    valid: results.filter((r) => r.status === STATUS_VALID).length,
    invalid: results.filter((r) => r.status === STATUS_INVALID).length,
    risky: results.filter((r) => r.status === STATUS_RISKY).length,
    unknown: results.filter((r) => r.status === STATUS_UNKNOWN).length,
    pending: results.filter((r) => r.status === STATUS_PENDING).length,
    error: results.filter((r) => r.status === STATUS_ERROR).length,
  };
}

module.exports = {
  STATUS_VALID,
  STATUS_INVALID,
  STATUS_RISKY,
  STATUS_UNKNOWN,
  STATUS_PENDING,
  STATUS_ERROR,
  parseInput,
  validateAddress,
  summaryOf,
  computeStatus,
  newResult,
};