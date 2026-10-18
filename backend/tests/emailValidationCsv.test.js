'use strict';

const fs = require('fs');
const ValidationJob = require('../src/models/ValidationJob');
const pipeline = require('../src/services/validation/pipeline');
const orchestrator = require('../src/services/validation/orchestrator');
const { authClient, clearDb, createUser, startDb, stopDb } = require('./helpers');

let client;
let user;
let warmDnsSpy;
let validateAddressSpy;

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'csv-validation@example.test' });
  client = await authClient(user);
});

afterAll(stopDb);

beforeEach(async () => {
  await clearDb();
  warmDnsSpy = jest.spyOn(orchestrator, 'warmDnsCache').mockResolvedValue(2);
  validateAddressSpy = jest.spyOn(pipeline, 'validateAddress').mockImplementation(async (raw) => ({
    raw,
    address: raw,
    normalized: raw.toLowerCase(),
    status: raw.startsWith('valid@') ? pipeline.STATUS_VALID : pipeline.STATUS_INVALID,
    reason: raw.startsWith('valid@') ? 'Syntax and domain checks passed' : 'Domain does not exist',
    confidence: 80,
    syntaxValid: true,
    domainExists: raw.startsWith('valid@'),
    mxFound: raw.startsWith('valid@'),
    fallbackUsed: false,
    disposable: false,
    roleBased: false,
    freeProvider: false,
    smtpAttempted: false,
    smtpResult: 'not_attempted',
    updatedAt: new Date(),
  }));
});

afterEach(() => {
  warmDnsSpy.mockRestore();
  validateAddressSpy.mockRestore();
});

it('exports only valid original lead rows from an uploaded CSV', async () => {
  const sourceCsv = [
    'Business Name,Email,Website',
    'Valid Company,valid@business.test,https://valid.business.test',
    'Invalid Company,invalid@missing.test,https://invalid.business.test',
    'No Email Company,,https://no-email.business.test',
  ].join('\n');

  const upload = await client
    .post('/api/validate/csv')
    .attach('file', Buffer.from(sourceCsv), 'all-leads.csv');

  expect(upload.status).toBe(201);
  expect(upload.body.emailColumn).toBe('Email');
  expect(upload.body.rowCount).toBe(3);

  let job;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    job = await ValidationJob.findById(upload.body.job.id).select('+inputFile');
    if (job && ['completed', 'failed'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (job.status === 'failed') throw new Error(job.error);
  expect(job.status).toBe('completed');
  expect(job.results.map((result) => result.rowIndex).sort()).toEqual([2, 3]);

  const response = await client.get(
    `/api/validate/jobs/${job.id}/export/valid-leads.csv`
  );
  expect(response.status).toBe(200);

  const exported = response.text.replace(/^\uFEFF/, '').trim().split('\n');
  expect(exported).toEqual([
    'Business Name,Email,Website',
    'Valid Company,valid@business.test,https://valid.business.test',
  ]);

  if (job.inputFile && fs.existsSync(job.inputFile)) fs.unlinkSync(job.inputFile);
});

it('queues email-list validation and returns ordered paginated results', async () => {
  const response = await client.post('/api/validate/email-list').send({
    emails: ['valid@first.test', 'invalid@missing.test', 'valid@last.test'],
  });

  expect(response.status).toBe(202);
  expect(response.body.job.kind).toBe('email-list');

  let job;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    job = await ValidationJob.findById(response.body.job.id);
    if (job && ['completed', 'failed'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (job.status === 'failed') throw new Error(job.error);
  expect(job.status).toBe('completed');
  expect(job.results.map((result) => result.address)).toEqual([
    'valid@first.test',
    'invalid@missing.test',
    'valid@last.test',
  ]);

  const resultsResponse = await client.get(`/api/validate/jobs/${job.id}/results?page=1&limit=2`);
  expect(resultsResponse.status).toBe(200);
  expect(resultsResponse.body.results.map((result) => result.address)).toEqual([
    'valid@first.test',
    'invalid@missing.test',
  ]);
  expect(resultsResponse.body.pagination).toMatchObject({ page: 1, pages: 2, total: 3 });
});
