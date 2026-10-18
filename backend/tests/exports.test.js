'use strict';

/** Server-side CSV / XLSX export tests. */

const Lead = require('../src/models/Lead');
const ExcelJS = require('exceljs');
const { app, authClient, clearDb, createUser, request, startDb, stopDb } = require('./helpers');

let client;
let user;

const SAMPLE = [
  {
    businessName: 'Cedar Ridge Roofing',
    category: 'Roofing',
    city: 'Hillsboro',
    state: 'OR',
    phone: '+15035550101',
    email: 'info@cedarridge.example.test',
    website: 'https://cedarridge.example.test',
    sourceUrl: 'https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201',
    publicEmails: ['info@cedarridge.example.test'],
    services: ['Roof Repair', 'Gutter Install'],
  },
  {
    businessName: 'Summit Plumbing',
    category: 'Plumbing',
    city: 'Portland',
    state: 'OR',
    phone: '+15035550102',
    email: 'hello@summitplumbing.example.test',
    website: null,
    sourceUrl: 'https://usdirectory.com/Summit-Plumbing-Portland-OR-100202',
  },
];

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'export@example.test' });
  client = await authClient(user);
});
afterAll(stopDb);

beforeEach(async () => {
  await clearDb();
  await Lead.insertMany(SAMPLE.map((lead) => ({ ...lead, user: user._id, demoData: true })));
});

describe('GET /api/leads/export/csv', () => {
  it('returns a CSV attachment with a header row', async () => {
    const response = await client.get('/api/leads/export/csv');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename=".*\.csv"/);

    const rows = response.text.trim().split('\n');
    expect(rows[0]).toContain('Business Name');
    expect(rows[0]).toContain('Source URL');
    expect(rows).toHaveLength(3); // header + 2 leads
    expect(response.text).toContain('Cedar Ridge Roofing');
  });

  it('honours the active filters', async () => {
    const response = await client.get('/api/leads/export/csv?city=Hillsboro');
    const rows = response.text.trim().split('\n');

    expect(rows).toHaveLength(2); // header + 1 lead
    expect(response.text).toContain('Cedar Ridge Roofing');
    expect(response.text).not.toContain('Summit Plumbing');
  });

  it('exports an explicit selection via ?ids=', async () => {
    const target = await Lead.findOne({ user: user._id, businessName: 'Summit Plumbing' });
    const response = await client.get(`/api/leads/export/csv?ids=${target.id}`);

    expect(response.text).toContain('Summit Plumbing');
    expect(response.text).not.toContain('Cedar Ridge Roofing');
  });

  it('exports only email addresses and excludes leads without an email', async () => {
    await Lead.create({
      user: user._id,
      businessName: 'No Email Roofing',
      city: 'Hillsboro',
      sourceUrl: 'https://example.test/no-email-csv',
      demoData: true,
    });

    const response = await client.get('/api/leads/export/csv?emailsOnly=true');
    const rows = response.text.trim().split('\n');

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/leadforge-emails-.*\.csv/);
    expect(rows[0]).toBe('Email');
    expect(rows.slice(1).sort()).toEqual([
      'info@cedarridge.example.test',
      'hello@summitplumbing.example.test',
    ].sort());
  });

  it('escapes commas and quotes in values', async () => {
    await Lead.create({
      user: user._id,
      businessName: 'Acme, "The" Roofing',
      city: 'Beaverton',
      sourceUrl: 'https://usdirectory.com/acme-quotes-1',
      demoData: true,
    });

    const response = await client.get('/api/leads/export/csv?city=Beaverton');
    expect(response.text).toContain('"Acme, ""The"" Roofing"');
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/leads/export/csv');
    expect(response.status).toBe(401);
  });

  it('only exports the caller\'s leads', async () => {
    const other = await createUser({ email: 'notmine@example.test' });
    await Lead.create({
      user: other._id,
      businessName: 'Someone Else Plumbing',
      sourceUrl: 'https://usdirectory.com/other-1',
    });

    const response = await client.get('/api/leads/export/csv');
    expect(response.text).not.toContain('Someone Else Plumbing');
  });

  it('records the export in the audit history', async () => {
    await client.get('/api/leads/export/csv');
    const response = await client.get('/api/exports');

    expect(response.status).toBe(200);
    expect(response.body.exports.length).toBeGreaterThan(0);
    expect(response.body.exports[0].format).toBe('csv');
  });
});

describe('GET /api/leads/export/xlsx', () => {
  it('returns a real xlsx workbook', async () => {
    const response = await client.get('/api/leads/export/xlsx');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(
      /spreadsheetml\.sheet/
    );
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.text || '', 'binary');
    // XLSX files are ZIP archives and start with the "PK" signature.
    expect(body.slice(0, 2).toString('latin1')).toBe('PK');
  });

  it('exports only email addresses in an email-only workbook', async () => {
    await Lead.create({
      user: user._id,
      businessName: 'No Email Roofing',
      sourceUrl: 'https://example.test/no-email-xlsx',
      demoData: true,
    });

    const response = await client
      .get('/api/leads/export/xlsx?emailsOnly=true')
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.text || '', 'binary');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body);
    const sheet = workbook.getWorksheet('Leads');

    expect(response.headers['content-disposition']).toMatch(/leadforge-emails-.*\.xlsx/);
    expect(sheet.getRow(1).values.slice(1)).toEqual(['Email']);
    expect([
      sheet.getRow(2).values[1],
      sheet.getRow(3).values[1],
    ].sort()).toEqual([
      'info@cedarridge.example.test',
      'hello@summitplumbing.example.test',
    ].sort());
    expect(sheet.rowCount).toBe(3);
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/leads/export/xlsx');
    expect(response.status).toBe(401);
  });
});