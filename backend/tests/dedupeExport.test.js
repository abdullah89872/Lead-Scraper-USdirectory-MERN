'use strict';

/** Unit tests: deduplication keys, merging and export row shaping. */

const { dedupeKeys, dedupeLeads, mergeLeadInto } = require('../src/services/dedupe');
const { EXPORT_COLUMNS, toExportRow } = require('../src/services/leadService');

const lead = (overrides = {}) => ({
  businessName: 'Cedar Ridge Roofing',
  source: 'usdirectory',
  sourceUrl: 'https://usdirectory.com/a-1',
  city: 'Hillsboro',
  state: 'OR',
  ...overrides,
});

describe('deduplication keys', () => {
  it('covers url, source id, email, phone, name+location and name+address', () => {
    const keys = dedupeKeys(
      lead({
        sourceId: '100201',
        email: 'info@acme.example.test',
        phone: '+15035550101',
        address: '4820 Main St, Hillsboro, OR 97123',
      })
    );
    const prefixes = new Set(keys.map((key) => key.split(':')[0]));
    ['url', 'src', 'email', 'phone', 'ncs', 'na'].forEach((prefix) => {
      expect(prefixes.has(prefix)).toBe(true);
    });
  });
});

describe('dedupeLeads', () => {
  it('merges the same source URL and fills the gaps', () => {
    const result = dedupeLeads([
      lead({ email: 'a@x.example.test' }),
      lead({ sourceUrl: 'https://usdirectory.com/a-1', phone: '+15035550101' }),
    ]);
    expect(result.leads).toHaveLength(1);
    expect(result.removed).toBe(1);
    expect(result.leads[0].email).toBe('a@x.example.test');
    expect(result.leads[0].phone).toBe('+15035550101');
  });

  it('merges on a shared phone', () => {
    const result = dedupeLeads([
      lead({ sourceUrl: 'https://usdirectory.com/a-1' }),
      lead({ sourceUrl: 'https://usdirectory.com/b-2', phone: '+15035550101' }),
    ]);
    expect(result.leads).toHaveLength(1);
  });

  it('merges on business name + city + state', () => {
    const result = dedupeLeads([
      lead({ sourceUrl: 'https://usdirectory.com/a-1' }),
      lead({ sourceUrl: 'https://usdirectory.com/b-2', businessName: 'Cedar Ridge Roofing Inc' }),
    ]);
    expect(result.leads).toHaveLength(1);
  });

  it('keeps genuinely different businesses apart', () => {
    const result = dedupeLeads([
      lead({ sourceUrl: 'https://usdirectory.com/a-1' }),
      lead({ sourceUrl: 'https://usdirectory.com/b-2', businessName: 'Summit Plumbing' }),
    ]);
    expect(result.leads).toHaveLength(2);
    expect(result.removed).toBe(0);
  });

  it('flags uncertain matches instead of merging them', () => {
    const result = dedupeLeads([
      lead({ sourceUrl: 'https://usdirectory.com/a-1', email: 'info@a.example.test' }),
      lead({
        sourceUrl: 'https://usdirectory.com/b-2',
        businessName: 'Cedar Ridge Roofers',
        email: 'info@b.example.test',
      }),
    ]);

    expect(result.leads).toHaveLength(2);
    expect(result.possibleDuplicates).toBe(1);
    result.leads.forEach((item) => {
      expect(item.possibleDuplicate).toBe(true);
      expect(item.duplicateReason).toEqual(expect.any(String));
    });
  });

  it('does not flag businesses in different cities', () => {
    const result = dedupeLeads([
      lead({ sourceUrl: 'https://usdirectory.com/a-1', city: 'Hillsboro' }),
      lead({ sourceUrl: 'https://usdirectory.com/b-2', city: 'Beaverton' }),
    ]);
    expect(result.possibleDuplicates).toBe(0);
  });
});

describe('mergeLeadInto', () => {
  it('fills gaps without overwriting existing values', () => {
    const primary = { ...lead(), phone: '+15035550101', publicEmails: [], publicPhones: [] };
    const other = {
      ...lead({ sourceUrl: 'https://usdirectory.com/b-2' }),
      phone: '+15035550102',
      email: 'new@x.example.test',
      publicEmails: ['new@x.example.test'],
      publicPhones: ['+15035550102'],
    };

    mergeLeadInto(primary, other);

    expect(primary.phone).toBe('+15035550101');
    expect(primary.email).toBe('new@x.example.test');
    expect(primary.publicEmails).toContain('new@x.example.test');
  });
});

describe('export rows', () => {
  it('exports every documented column', () => {
    const row = toExportRow({
      ...lead(),
      publicEmails: ['a@x.test', 'b@x.test'],
      publicPhones: ['+15035550101'],
      services: ['Roof Repair'],
      scrapedAt: new Date('2024-01-02T03:04:05.000Z'),
    });

    EXPORT_COLUMNS.forEach(({ key }) => expect(row).toHaveProperty(key));
    expect(row.publicEmails).toBe('a@x.test; b@x.test');
    expect(row.services).toBe('Roof Repair');
    expect(row.scrapedAt).toBe('2024-01-02T03:04:05.000Z');
  });

  it('writes empty strings for missing values instead of "undefined"', () => {
    const row = toExportRow({ ...lead(), email: null, website: null, category: undefined });
    expect(row.email).toBe('');
    expect(row.website).toBe('');
    expect(row.category).toBe('');
  });
});