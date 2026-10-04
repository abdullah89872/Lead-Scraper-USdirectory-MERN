'use strict';

/** Dashboard stats, saved lists and runtime settings. */

const Job = require('../src/models/Job');
const Lead = require('../src/models/Lead');
const LeadList = require('../src/models/LeadList');
const { app, authClient, clearDb, createUser, request, startDb, stopDb } = require('./helpers');

let client;
let user;

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'dash@example.test' });
  client = await authClient(user);
});
afterAll(stopDb);

beforeEach(async () => {
  await clearDb();
  await Lead.insertMany([
    {
      businessName: 'Cedar Ridge Roofing',
      category: 'Roofing',
      city: 'Hillsboro',
      state: 'OR',
      phone: '+15035550101',
      email: 'info@cedarridge.example.test',
      website: 'https://cedarridge.example.test',
      source: 'usdirectory',
      sourceUrl: 'https://usdirectory.com/a-1',
      user: user._id,
      demoData: true,
    },
    {
      businessName: 'Summit Plumbing',
      category: 'Plumbing',
      city: 'Portland',
      state: 'OR',
      phone: '+15035550102',
      email: null,
      website: null,
      source: 'usdirectory',
      sourceUrl: 'https://usdirectory.com/b-2',
      user: user._id,
      demoData: true,
    },
  ]);
});

describe('GET /api/dashboard/stats', () => {
  it('returns the dashboard cards', async () => {
    await Job.create({
      user: user._id,
      category: 'Roofing',
      location: 'Hillsboro, OR',
      status: 'running',
    });

    const response = await client.get('/api/dashboard/stats');

    expect(response.status).toBe(200);
    expect(response.body.totals.leads).toBe(2);
    expect(response.body.totals.emails).toBe(1);
    expect(response.body.totals.phones).toBe(2);
    expect(response.body.totals.websites).toBe(1);
    expect(response.body.totals.activeJobs).toBe(1);
    expect(response.body.coverage.emailPct).toBe(50);
    expect(Array.isArray(response.body.leadsByDay)).toBe(true);
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/dashboard/stats');
    expect(response.status).toBe(401);
  });

  it('ignores another user\'s data', async () => {
    const other = await createUser({ email: 'dashother@example.test' });
    await Lead.create({
      user: other._id,
      businessName: 'Not Mine',
      sourceUrl: 'https://usdirectory.com/x-1',
    });

    const response = await client.get('/api/dashboard/stats');
    expect(response.body.totals.leads).toBe(2);
  });
});

describe('lead lists', () => {
  it('creates a list from selected leads and reads it back', async () => {
    const leads = await Lead.find({ user: user._id });
    const created = await client.post('/api/lists').send({
      name: 'Hillsboro roofers',
      leadIds: leads.map((lead) => lead.id),
    });

    expect(created.status).toBe(201);
    expect(created.body.list.leadCount).toBe(2);

    const fetched = await client.get(`/api/lists/${created.body.list.id}`);
    expect(fetched.status).toBe(200);
  });

  it('lists only the caller\'s lists', async () => {
    const other = await createUser({ email: 'otherlist@example.test' });
    await LeadList.create({ user: other._id, name: 'Private', leads: [] });

    const response = await client.get('/api/lists');
    expect(response.body.lists).toHaveLength(0);
  });

  it('rejects a duplicate list name', async () => {
    await client.post('/api/lists').send({ name: 'Same' });
    const response = await client.post('/api/lists').send({ name: 'Same' });
    expect(response.status).toBe(409);
  });

  it('deletes a list without deleting its leads', async () => {
    const list = await LeadList.create({ user: user._id, name: 'Temp', leads: [] });
    const response = await client.delete(`/api/lists/${list.id}`);

    expect(response.status).toBe(200);
    expect(await Lead.countDocuments({ user: user._id })).toBe(2);
  });

  it('refuses to delete a list owned by somebody else', async () => {
    const other = await createUser({ email: 'listguard@example.test' });
    const list = await LeadList.create({ user: other._id, name: 'Theirs', leads: [] });

    const response = await client.delete(`/api/lists/${list.id}`);
    expect(response.status).toBe(404);
  });
});

describe('GET /api/settings', () => {
  it('reports runtime configuration without secrets', async () => {
    const response = await client.get('/api/settings');

    expect(response.status).toBe(200);
    expect(response.body.scraper.mode).toBe('mock');
    expect(response.body.ai.configured).toBe(false);
    expect(response.body.user.email).toBe('dash@example.test');

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(process.env.JWT_SECRET);
    expect(body).not.toContain('passwordHash');
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/settings');
    expect(response.status).toBe(401);
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/Route not found/);
  });
});