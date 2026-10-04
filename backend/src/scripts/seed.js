'use strict';

/**
 * Seed the database with demo data.
 *
 *   npm run seed              -> demo user + 2 completed jobs + leads
 *   npm run seed -- --reset   -> wipe users/jobs/leads first
 *
 * Everything it creates is clearly synthetic (reserved 555-01xx numbers,
 * @example.com emails, *.example.com websites, demoData=true). No real
 * business information is produced or stored.
 */

const Job = require('../models/Job');
const Lead = require('../models/Lead');
const User = require('../models/User');
const mockScraper = require('../services/mockScraper');
const { normalizeLead } = require('../services/normalize');
const { connectDb, disconnectDb } = require('../db/connect');
const { dedupeLeads } = require('../services/dedupe');

const DEMO_USER = { name: 'Demo User', email: 'demo@leadforge.test', password: 'Demo12345!' };

const SEED_JOBS = [
  { category: 'Roofing', location: 'Hillsboro, Oregon', maxLeads: 120, enrichment: true, ai: false },
  { category: 'Plumbing', location: 'Portland, Oregon', maxLeads: 80, enrichment: true, ai: false },
  { category: 'Electrician', location: 'Beaverton, Oregon', maxLeads: 60, enrichment: false, ai: false },
];

async function reset() {
  await Promise.all([Lead.deleteMany({}), Job.deleteMany({}), User.deleteMany({})]);
  console.log('Cleared leads, jobs and users.');
}

async function findOrCreateUser() {
  const existing = await User.findOne({ email: DEMO_USER.email });
  if (existing) return existing;
  return User.create({
    name: DEMO_USER.name,
    email: DEMO_USER.email,
    passwordHash: await User.hashPassword(DEMO_USER.password),
    role: 'admin',
  });
}

async function seedJob(user, spec) {
  const result = await mockScraper.scrape({
    category: spec.category,
    location: spec.location,
    maxLeads: spec.maxLeads,
    enrichment: spec.enrichment,
  });

  const normalized = result.leads.map((lead) => normalizeLead(lead)).filter(Boolean);
  const batch = dedupeLeads(normalized);

  const startedAt = new Date(Date.now() - Math.floor(Math.random() * 6) * 3600 * 1000);
  const job = await Job.create({
    user: user._id,
    source: 'usdirectory',
    category: spec.category,
    location: spec.location,
    maxLeads: spec.maxLeads,
    enrichment: spec.enrichment,
    ai: spec.ai,
    mode: 'mock',
    status: 'completed',
    startedAt,
    completedAt: new Date(startedAt.getTime() + 45000),
    leadsCount: batch.leads.length,
    warnings: result.warnings,
    progress: {
      stage: 'completed',
      percent: 100,
      message: `${batch.leads.length} leads saved`,
      leadsFound: batch.leads.length,
      updatedAt: new Date(),
    },
    stats: result.stats,
  });

  const docs = await Lead.insertMany(
    batch.leads.map((lead) => ({ ...lead, user: user._id, job: job._id, demoData: true }))
  );

  console.log(
    `  ${spec.category} in ${spec.location}: ${docs.length} leads (job ${job.id})`
  );
  return { job, count: docs.length };
}

async function main() {
  const shouldReset = process.argv.includes('--reset');
  await connectDb();

  console.log('Seeding LeadForge AI demo data...');
  if (shouldReset) await reset();

  const user = await findOrCreateUser();
  console.log(`  user: ${user.email} (${user.role})`);

  let total = 0;
  for (const spec of SEED_JOBS) {
    // eslint-disable-next-line no-await-in-loop
    const { count } = await seedJob(user, spec);
    total += count;
  }

  console.log(`\nDone. ${total} demo leads across ${SEED_JOBS.length} jobs.`);
  console.log(`Sign in with  ${DEMO_USER.email}  /  ${DEMO_USER.password}\n`);
}

main()
  .then(() => disconnectDb())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Seed failed:', error.message);
    await disconnectDb().catch(() => {});
    process.exit(1);
  });