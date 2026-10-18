'use strict';

/** Job creation, validation and listing. */

const Job = require('../src/models/Job');
const {
  app,
  authClient,
  clearDb,
  createUser,
  request,
  startDb,
  stopDb,
} = require('./helpers');

let client;
let user;

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'jobs@example.test' });
  client = await authClient(user);
});
afterAll(stopDb);
beforeEach(clearDb);

describe('POST /api/jobs', () => {
  it('creates a queued job', async () => {
    const response = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 25,
    });

    expect(response.status).toBe(201);
    expect(response.body.job.status).toMatch(/queued|running|completed/);
    expect(response.body.job.category).toBe('Roofing');
    expect(response.body.job.location).toBe('Hillsboro, Oregon');
    expect(response.body.job.maxLeads).toBe(25);
    expect(response.body.job.mode).toBe('mock');
  });

  it('requires authentication', async () => {
    const response = await request(app)
      .post('/api/jobs')
      .send({ category: 'Roofing', location: 'Hillsboro, Oregon', maxLeads: 5 });
    expect(response.status).toBe(401);
  });

  it.each([
    [{ location: 'Hillsboro, Oregon' }, 'category'],
    [{ category: 'Roofing' }, 'location'],
    [{ category: 'R', location: 'Hillsboro, Oregon' }, 'category'],
    [{ category: 'Roofing', location: 'Hillsboro, Oregon', maxLeads: 0 }, 'maxLeads'],
    [{ category: 'Roofing', location: 'Hillsboro, Oregon', maxLeads: 1001 }, 'maxLeads'],
    [{ category: 'Roofing', location: 'Hillsboro, Oregon', maxLeads: 'many' }, 'maxLeads'],
  ])('rejects invalid payloads (%#)', async (payload) => {
    const response = await client.post('/api/jobs').send(payload);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(Array.isArray(response.body.details)).toBe(true);
  });

  it('defaults maxLeads, enrichment and ai', async () => {
    const response = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
    });
    expect(response.body.job.maxLeads).toBe(100);
    expect(response.body.job.enrichment).toBe(true);
    expect(response.body.job.ai).toBe(false);
  });

  it('coerces string booleans from form-style input', async () => {
    const response = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: '10',
      enrichment: 'false',
      ai: 'true',
    });
    expect(response.status).toBe(201);
    expect(response.body.job.maxLeads).toBe(10);
    expect(response.body.job.enrichment).toBe(false);
    expect(response.body.job.ai).toBe(true);
  });
});

describe('GET /api/jobs', () => {
  it('lists only the authenticated user\'s jobs', async () => {
    await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 3,
    });

    const other = await createUser({ email: 'other@example.test' });
    const otherClient = await authClient(other);

    const mine = await client.get('/api/jobs');
    const theirs = await otherClient.get('/api/jobs');

    expect(mine.status).toBe(200);
    expect(mine.body.jobs.length).toBeGreaterThan(0);
    expect(theirs.body.jobs).toHaveLength(0);
  });

  it('supports pagination and status filtering', async () => {
    await Job.create([
      { user: user._id, category: 'A', location: 'Hillsboro, OR', status: 'queued' },
      { user: user._id, category: 'B', location: 'Hillsboro, OR', status: 'completed' },
      { user: user._id, category: 'C', location: 'Hillsboro, OR', status: 'completed' },
    ]);

    const filtered = await client.get('/api/jobs?status=completed');
    expect(filtered.body.jobs).toHaveLength(2);
    expect(filtered.body.pagination.total).toBe(2);

    const paged = await client.get('/api/jobs?page=1&limit=2');
    expect(paged.body.jobs.length).toBeLessThanOrEqual(2);
  });

  it('exposes the available statuses for the UI', async () => {
    const response = await client.get('/api/jobs/meta/statuses');
    expect(response.status).toBe(200);
    expect(response.body.statuses).toEqual(
      expect.arrayContaining(['queued', 'running', 'completed', 'failed', 'cancelled'])
    );
  });
});

describe('GET /api/jobs/:id', () => {
  it('returns one job', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 3,
    });
    const response = await client.get(`/api/jobs/${created.body.job.id}`);
    expect(response.status).toBe(200);
    expect(response.body.job.id).toBe(created.body.job.id);
  });

  it('returns 404 for a job owned by somebody else', async () => {
    const created = await client.post('/api/jobs').send({
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 3,
    });
    const other = await createUser({ email: 'nosy@example.test' });
    const otherClient = await authClient(other);

    const response = await otherClient.get(`/api/jobs/${created.body.job.id}`);
    expect(response.status).toBe(404);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('cancels a queued job', async () => {
    const job = await Job.create({
      user: user._id,
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 10,
      status: 'queued',
    });

    const response = await client.post(`/api/jobs/${job.id}/cancel`);
    expect(response.status).toBe(200);
    expect(response.body.job.status).toBe('cancelled');
  });

  it('refuses to cancel a completed job with 409', async () => {
    const job = await Job.create({
      user: user._id,
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 10,
      status: 'completed',
    });
    const response = await client.post(`/api/jobs/${job.id}/cancel`);
    expect(response.status).toBe(409);
  });

  it('returns 404 for a job owned by somebody else', async () => {
    const owner = await createUser({ email: 'owner2@example.test' });
    const job = await Job.create({
      user: owner._id,
      category: 'Roofing',
      location: 'Hillsboro, Oregon',
      maxLeads: 10,
      status: 'queued',
    });
    const response = await client.post(`/api/jobs/${job.id}/cancel`);
    expect(response.status).toBe(404);
  });
});