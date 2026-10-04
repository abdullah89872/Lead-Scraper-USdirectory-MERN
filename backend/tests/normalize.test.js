'use strict';

/** Unit tests: email / phone / name normalization and lead shaping. */

const { normalizeEmail, normalizeLead, normalizePhone } = require('../src/services/normalize');
const { normalizeName } = require('../src/services/dedupe');

const lead = (overrides = {}) => ({
  businessName: 'Cedar Ridge Roofing',
  source: 'usdirectory',
  sourceUrl: 'https://usdirectory.com/a-1',
  city: 'Hillsboro',
  state: 'OR',
  ...overrides,
});

describe('email normalization', () => {
  it.each([
    ['Info@Example.COM', 'info@example.com'],
    ['  info@example.com  ', 'info@example.com'],
    ['mailto:info@example.com', 'info@example.com'],
    ['info@example.com?subject=hi', 'info@example.com'],
    ['info@example.com.', 'info@example.com'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it('returns null for values that are not addresses', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
  });
});

describe('phone normalization', () => {
  it.each([
    ['(503) 555-0101', '+15035550101'],
    ['503.555.0101', '+15035550101'],
    ['+1 503 555 0101', '+15035550101'],
    ['5035550101', '+15035550101'],
    ['503-555-0101 ext. 22', '+15035550101'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('rejects numbers that cannot be a real US number', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('000-000-0000')).toBeNull();
    expect(normalizePhone('111-111-1111')).toBeNull();
    expect(normalizePhone('503-055-0101')).toBeNull();
    expect(normalizePhone('call us')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('business name normalization', () => {
  it('drops legal suffixes and punctuation', () => {
    expect(normalizeName('The Cedar Ridge Roofing Co., LLC')).toBe('cedar ridge roofing');
    expect(normalizeName('Cedar Ridge Roofing, Inc.')).toBe('cedar ridge roofing');
  });

  it('is empty for missing names', () => {
    expect(normalizeName(null)).toBe('');
  });
});

describe('normalizeLead', () => {
  it('normalizes fields and keeps missing values as null', () => {
    const result = normalizeLead(
      lead({
        email: '  INFO@AcmeRoofing.test ',
        phone: '(503) 555-0101',
        website: null,
        description: null,
      })
    );

    expect(result.email).toBe('info@acmeroofing.test');
    expect(result.phone).toBe('+15035550101');
    expect(result.website).toBeNull();
    expect(result.description).toBeNull();
  });

  it('drops placeholder addresses that a source never really publishes', () => {
    const result = normalizeLead(lead({ email: 'yourname@example.com' }));
    expect(result.email).toBeNull();
    expect(result.emailStatus).toBe('unknown');
  });

  it('rejects a lead with no name or no source URL', () => {
    expect(normalizeLead(lead({ businessName: '' }))).toBeNull();
    expect(normalizeLead(lead({ sourceUrl: '' }))).toBeNull();
  });
});