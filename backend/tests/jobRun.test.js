'use strict';

/** End-to-end mock pipeline: a queued job really produces stored leads. */

const Job = require('../src/models/Job');
const Lead = require('../src/models/Lead');
const {
  authClient,
  clearDb,
  createUser,
  registerUser,
  startDb,
  stopDb,
  waitForJob,
} = require('./helpers');

let client;
let user;

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'runs@example.test' });
  client = await authClient(user);
});
afterAll(stopDb);
beforeEach(clearDb);

describe('running a job in mock mode', () => {
  it('completes and persists leads', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 20,
    });
    expect(created.status).toBe(201);

    const finished = await waitForJob(created.body.job.id);
    expect(finished.status).toBe('completed');
    expect(finished.leadsCount).toBeGreaterThan(0);
    expect(finished.progress.percent).toBe(100);

    const leads = await Lead.find({ user: user._id });
    expect(leads.length).toBe(finished.leadsCount);
    expect(leads.length).toBeLessThanOrEqual(20);
  });

  it('stores a source URL on every lead and flags demo data', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Plumbing',
      location: 'Portland, Oregon',
      maxLeads: 10,
    });
    await waitForJob(created.body.job.id);

    const leads = await Lead.find({ user: user._id });
    expect(leads.length).toBeGreaterThan(0);
    leads.forEach((lead) => {
      expect(lead.sourceUrl).toMatch(/^https:\/\/usdirectory\.com\//);
      expect(lead.demoData).toBe(true);
      expect(lead.businessName).toEqual(expect.any(String));
    });
  });

  it('respects the maximum-leads limit', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Electrician',
      location: 'Beaverton, Oregon',
      maxLeads: 5,
    });
    const finished = await waitForJob(created.body.job.id);
    expect(finished.leadsCount).toBeLessThanOrEqual(5);
  });

  it('never fabricates contact details', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 40,
      enrichment: true,
    });
    await waitForJob(created.body.job.id);

    const leads = await Lead.find({ user: user._id });
    expect(leads.length).toBeGreaterThan(0);
    leads.forEach((lead) => {
      if (lead.email) expect(lead.email).toMatch(/@/);
      if (lead.phone) expect(lead.phone).toMatch(/^\+1\d{10}$/);
      if (lead.email) expect(lead.email.endsWith('example.com')).toBe(true);
      expect(lead.city).toBeTruthy();
    });
  });

  it('merges duplicates instead of creating copies', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 15,
    });
    await waitForJob(created.body.job.id);

    const leads = await Lead.find({ user: user._id });
    const urls = leads.map((lead) => lead.sourceUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('is idempotent when the same job runs twice', async () => {
    const first = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 12,
    });
    await waitForJob(first.body.job.id);
    const afterFirst = await Lead.countDocuments({ user: user._id });

    const second = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 12,
    });
    await waitForJob(second.body.job.id);
    const afterSecond = await Lead.countDocuments({ user: user._id });

    expect(afterSecond).toBe(afterFirst);
  });

  it('does not leak leads to another user', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 6,
    });
    await waitForJob(created.body.job.id);

    const other = await createUser({ email: 'stranger@example.test' });
    const otherClient = await authClient(other);
    const response = await otherClient.get('/api/leads');

    expect(response.body.leads).toHaveLength(0);
  });

  it('a freshly registered user can immediately run a job', async () => {
    const { client: newClient } = await registerUser();
    const created = await newClient.post('/api/jobs').send({
      category: 'HVAC',
      location: 'Salem, Oregon',
      maxLeads: 4,
    });
    expect(created.status).toBe(201);
    const finished = await waitForJob(created.body.job.id);
    expect(finished.status).toBe('completed');
  });

  it('records the job status transitions in the database', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 3,
    });
    const finished = await waitForJob(created.body.job.id);
    const stored = await Job.findById(created.body.job.id);

    expect(stored.status).toBe('completed');
    expect(stored.startedAt).toBeTruthy();
    expect(stored.completedAt).toBeTruthy();
    expect(finished.completedAt.getTime()).toBeGreaterThanOrEqual(finished.startedAt.getTime());
  });
});