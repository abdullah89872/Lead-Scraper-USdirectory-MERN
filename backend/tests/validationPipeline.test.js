'use strict';

const env = require('../src/config/env');
const dns = require('../src/services/validation/dns');
const smtp = require('../src/services/validation/smtp');
const pipeline = require('../src/services/validation/pipeline');

const originalSmtpEnabled = env.validation.smtp.enabled;
const originalValidPolicy = env.validation.validPolicy;

beforeEach(() => {
  env.validation.smtp.enabled = true;
  env.validation.validPolicy = 'smtp';
  jest.spyOn(dns, 'checkDomain').mockResolvedValue({
    domain: 'example.com',
    status: 'ok',
    mxFound: true,
    mxHosts: [{ exchange: 'mx.example.com', priority: 10 }],
    fallbackUsed: false,
    reason: null,
  });
  jest.spyOn(smtp, 'verifyRecipient').mockResolvedValue({
    result: smtp.RESULTS.ACCEPTED,
    catchAll: false,
    code: null,
    enhanced: null,
    message: null,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  env.validation.smtp.enabled = originalSmtpEnabled;
  env.validation.validPolicy = originalValidPolicy;
});

test('validates an address over SMTP and only marks accepted recipients valid', async () => {
  const result = await pipeline.validateAddress('person@example.com');

  expect(smtp.verifyRecipient).toHaveBeenCalledTimes(1);
  expect(result.smtpAttempted).toBe(true);
  expect(result.smtpResult).toBe(smtp.RESULTS.ACCEPTED);
  expect(result.status).toBe(pipeline.STATUS_VALID);
});

test('keeps SMTP-deferred recipients unknown instead of treating them as verified', async () => {
  dns.checkDomain.mockResolvedValue({
    domain: 'example.com',
    status: 'ok',
    mxFound: false,
    mxHosts: [],
    fallbackUsed: true,
    reason: null,
  });
  smtp.verifyRecipient.mockResolvedValue({
    result: smtp.RESULTS.NOT_ATTEMPTED,
    catchAll: null,
    code: null,
    enhanced: null,
    message: null,
  });

  const result = await pipeline.validateAddress('person@example.com');

  expect(result.smtpAttempted).toBe(false);
  expect(result.status).toBe(pipeline.STATUS_UNKNOWN);
  expect(result.reason).toMatch(/SMTP verification was not completed/);
});

test('reports unexpected SMTP outcomes as unknown rather than pending', async () => {
  smtp.verifyRecipient.mockResolvedValue({
    result: smtp.RESULTS.ERROR,
    catchAll: null,
    code: null,
    enhanced: null,
    message: 'unexpected error',
  });

  const result = await pipeline.validateAddress('person@example.com');

  expect(result.smtpAttempted).toBe(true);
  expect(result.status).toBe(pipeline.STATUS_UNKNOWN);
});

test('does not mark a known catch-all SMTP server as a verified mailbox', async () => {
  smtp.verifyRecipient.mockResolvedValue({
    result: smtp.RESULTS.ACCEPTED,
    catchAll: true,
    code: null,
    enhanced: null,
    message: null,
  });

  const result = await pipeline.validateAddress('person@example.com');

  expect(result.status).toBe(pipeline.STATUS_UNKNOWN);
  expect(result.reason).toMatch(/accepts arbitrary recipients/);
});
