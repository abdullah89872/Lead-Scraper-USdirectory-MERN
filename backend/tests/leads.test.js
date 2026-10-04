'use strict';

/** Leads API: listing, search, filters and pagination. */

const Lead = require('../src/models/Lead');
const { app, authClient, clearDb, createUser, request, startDb, stopDb } = require('./helpers');

let client;
let user;

const SAMPLE = [
  {
    businessName: 'Cedar Ridge Roofing',
    category: 'Roofing',
    city: 'Hillsboro',
    state: 'OR',
    zip: '97123',
    phone: '+15035550101',
    email: 'info@cedarridge.example.test',
    website: 'https://cedarridge.example.test',
    sourceUrl: 'https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201',
  },
  {
    businessName: 'Summit Plumbing',
    category: 'Plumbing',
    city: 'Portland',
    state: 'OR',
    zip: '97201',
    phone: '+15035550102',
    email: 'hello@summitplumbing.example.test',
    website: null,
    sourceUrl: 'https://usdirectory.com/Summit-Plumbing-Portland-OR-100202',
  },
  {
    businessName: 'Blue Sky Electric',
    category: 'Electrical',
    city: 'Beaverton',
    state: 'OR',
    zip: '97005',
    phone: null,
    email: null,
    website: 'https://bluesky.example.test',
    sourceUrl: 'https://usdirectory.com/Blue-Sky-Electric-Beaverton-OR-100203',
  },
];

beforeAll(async () => {
  await startDb();
  user = await createUser({ email: 'leads@example.test' });
  client = await authClient(user);
});
afterAll(stopDb);

beforeEach(async () => {
  await clearDb();
  await Lead.insertMany(SAMPLE.map((lead) => ({ ...lead, user: user._id, demoData: true })));
});

describe('GET /api/leads', () => {
  it('returns the lead table with pagination metadata', async () => {
    const response = await client.get('/api/leads');
    expect(response.status).toBe(200);
    expect(response.body.leads).toHaveLength(3);
    expect(response.body.pagination).toEqual(
      expect.objectContaining({ page: 1, limit: 25, total: 3 })
    );
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/leads');
    expect(response.status).toBe(401);
  });

  it('searches across name, email, city and phone', async () => {
    const byName = await client.get('/api/leads?search=Cedar');
    expect(byName.body.leads).toHaveLength(1);

    const byEmail = await client.get('/api/leads?search=summitplumbing');
    expect(byEmail.body.leads).toHaveLength(1);

    const byCity = await client.get('/api/leads?search=Beaverton');
    expect(byCity.body.leads).toHaveLength(1);
  });

  it('treats search input as a literal string, not a regex', async () => {
    const response = await client.get('/api/leads?search=.*');
    expect(response.status).toBe(200);
    expect(response.body.leads).toHaveLength(0);
  });

  it('filters by city and category', async () => {
    const byCity = await client.get('/api/leads?city=Hillsboro');
    expect(byCity.body.leads).toHaveLength(1);

    const byCategory = await client.get('/api/leads?category=Plumbing');
    expect(byCategory.body.leads).toHaveLength(1);
  });

  it('filters by presence of contact details', async () => {
    const withEmail = await client.get('/api/leads?hasEmail=true');
    expect(withEmail.body.leads).toHaveLength(2);

    const withPhone = await client.get('/api/leads?hasPhone=true');
    expect(withPhone.body.leads).toHaveLength(2);

    const withWebsite = await client.get('/api/leads?hasWebsite=true');
    expect(withWebsite.body.leads).toHaveLength(2);
  });

  it('paginates', async () => {
    const page1 = await client.get('/api/leads?page=1&limit=2');
    const page2 = await client.get('/api/leads?page=2&limit=2');

    expect(page1.body.leads).toHaveLength(2);
    expect(page2.body.leads).toHaveLength(1);
    expect(page1.body.pagination.pages).toBe(2);
  });

  it('sorts by a whitelisted field', async () => {
    const response = await client.get('/api/leads?sort=businessName');
    expect(response.status).toBe(200);
    const names = response.body.leads.map((lead) => lead.businessName);
    expect(names[0]).toBe('Blue Sky Electric');
  });

  it('falls back to a safe sort for an unknown field', async () => {
    const response = await client.get('/api/leads?sort=passwordHash');
    expect(response.status).toBe(200);
  });

  it('rejects an invalid page number', async () => {
    const response = await client.get('/api/leads?page=0');
describe('GET /api/leads/:id', () => {
  it('returns a single lead with its source URL', async () => {
    const lead = await Lead.findOne({ user: user._id, businessName: 'Cedar Ridge Roofing' });
    const response = await client.get(`/api/leads/${lead.id}`);

    expect(response.status).toBe(200);
    expect(response.body.lead.id).toBe(lead.id);
    expect(response.body.lead.sourceUrl).toBe(lead.sourceUrl);
  });

  it('returns 404 for an unknown id', async () => {
    const response = await client.get('/api/leads/64b7f1c2a1b2c3d4e5f60718');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a lead owned by another user', async () => {
    const other = await createUser({ email: 'leadowner@example.test' });
    const foreign = await Lead.create({
      user: other._id,
      businessName: 'Foreign Lead',
      sourceUrl: 'https://usdirectory.com/x-1',
    });

    const response = await client.get(`/api/leads/${foreign.id}`);
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/leads/:id', () => {
  it('deletes the lead', async () => {
    const lead = await Lead.findOne({ user: user._id });
    const response = await client.delete(`/api/leads/${lead.id}`);

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(true);
    expect(await Lead.findById(lead.id)).toBeNull();
  });

  it('refuses to delete a lead owned by another user', async () => {
    const other = await createUser({ email: 'guard@example.test' });
    const foreign = await Lead.create({
      user: other._id,
      businessName: 'Not Yours',
      sourceUrl: 'https://usdirectory.com/x-2',
    });

    const response = await client.delete(`/api/leads/${foreign.id}`);
    expect(response.status).toBe(404);
    expect(await Lead.findById(foreign.id)).not.toBeNull();
  });

  it('rejects a malformed id', async () => {
    const response = await client.delete('/api/leads/not-an-id');
    expect(response.status).toBe(400);
  });
});

describe('POST /api/leads/bulk-delete', () => {
  it('deletes several leads at once', async () => {
    const leads = await Lead.find({ user: user._id }).limit(2);
    const response = await client.post('/api/leads/bulk-delete').send({
      ids: leads.map((lead) => lead.id),
    });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(2);
    expect(await Lead.countDocuments({ user: user._id })).toBe(1);
  });
});
    expect(response.status).toBe(400);
  });

  it('exposes filter dropdown values', async () => {
    const response = await client.get('/api/leads/meta/filters');
    expect(response.status).toBe(200);
    expect(response.body.cities).toEqual(expect.arrayContaining(['Hillsboro', 'Portland']));
    expect(response.body.sources).toContain('usdirectory');
  });
});