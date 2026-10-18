'use strict';

/** Lead querying, filtering, pagination and export row shaping. */

const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const LeadList = require('../models/LeadList');

const EXPORT_COLUMNS = [
  { key: 'businessName', header: 'Business Name', width: 32 },
  { key: 'category', header: 'Category', width: 22 },
  { key: 'description', header: 'Description', width: 60 },
  { key: 'address', header: 'Address', width: 34 },
  { key: 'city', header: 'City', width: 18 },
  { key: 'state', header: 'State', width: 8 },
  { key: 'zip', header: 'ZIP', width: 10 },
  { key: 'phone', header: 'Phone', width: 18 },
  { key: 'email', header: 'Email', width: 30 },
  { key: 'website', header: 'Website', width: 34 },
  { key: 'source', header: 'Source', width: 14 },
  { key: 'sourceUrl', header: 'Source URL', width: 60 },
  { key: 'contactPageUrl', header: 'Contact Page URL', width: 46 },
  { key: 'publicEmails', header: 'Public Emails', width: 40 },
  { key: 'publicPhones', header: 'Public Phones', width: 28 },
  { key: 'services', header: 'Services', width: 40 },
  { key: 'aiCategory', header: 'AI Category', width: 20 },
  { key: 'aiTags', header: 'AI Tags', width: 28 },
  { key: 'emailStatus', header: 'Email Status', width: 14 },
  { key: 'emailConfidence', header: 'Email Confidence', width: 12 },
  { key: 'emailSyntaxValid', header: 'Syntax Valid', width: 12 },
  { key: 'emailDomainExists', header: 'Domain Exists', width: 14 },
  { key: 'emailMxFound', header: 'MX Found', width: 10 },
  { key: 'emailDisposable', header: 'Disposable', width: 12 },
  { key: 'emailRoleBased', header: 'Role Based', width: 12 },
  { key: 'emailSmtpResult', header: 'SMTP Result', width: 16 },
  { key: 'emailReason', header: 'Validation Reason', width: 40 },
  { key: 'enrichmentStatus', header: 'Enrichment Status', width: 18 },
  { key: 'scrapedAt', header: 'Scraped At', width: 22 },
];

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build a Mongo filter for the authenticated user from query params. */
async function buildLeadQuery(userId, query = {}) {
  const filter = { user: userId };

  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search.trim()), 'i');
    filter.$or = [
      { businessName: rx },
      { email: rx },
      { phone: rx },
      { city: rx },
      { category: rx },
      { website: rx },
      { address: rx },
    ];
  }

  ['category', 'city', 'source', 'state', 'emailStatus', 'enrichmentStatus'].forEach((field) => {
    if (query[field]) filter[field] = new RegExp(`^${escapeRegex(query[field].trim())}$`, 'i');
  });

  if (query.job && mongoose.isValidObjectId(query.job)) filter.job = query.job;

  if (
    String(query.emailsOnly).toLowerCase() === 'true' ||
    String(query.hasEmail).toLowerCase() === 'true'
  ) {
    filter.email = { $exists: true, $nin: [null, ''] };
  }
  if (String(query.hasPhone).toLowerCase() === 'true') filter.phone = { $ne: null };
  if (String(query.hasWebsite).toLowerCase() === 'true') filter.website = { $ne: null };

  if (query.list && mongoose.isValidObjectId(query.list)) {
    const list = await LeadList.findOne({ _id: query.list, user: userId }).select('leads').lean();
    filter._id = { $in: (list?.leads || []).map((id) => id) };
  }

  if (query.ids) {
    const ids = String(query.ids)
      .split(',')
      .map((id) => id.trim())
      .filter((id) => mongoose.isValidObjectId(id));
    filter._id = { $in: ids };
  }

  return filter;
}

function buildSort(sort = '-createdAt') {
  const allowed = new Set([
    'createdAt', 'updatedAt', 'businessName', 'city', 'state', 'category',
    'scrapedAt', 'email', 'enrichmentStatus', 'emailStatus',
  ]);
  const descending = String(sort).startsWith('-');
  const field = String(sort).replace(/^-/, '');
  if (!allowed.has(field)) return { createdAt: -1 };
  return { [field]: descending ? -1 : 1 };
}

async function listLeads(userId, query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit, 10) || 25));
  const filter = await buildLeadQuery(userId, query);

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .sort(buildSort(query.sort))
      .skip((page - 1) * limit)
      .limit(limit),
    Lead.countDocuments(filter),
  ]);

  return {
    items,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getLead(userId, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Lead.findOne({ _id: id, user: userId });
}

/** Stream matching leads in batches (used by exports). */
async function* iterateLeads(userId, query = {}, batchSize = 500) {
  const filter = await buildLeadQuery(userId, query);
  const cursor = Lead.find(filter).sort(buildSort(query.sort || 'createdAt')).cursor();
  let batch = [];
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

const joinList = (value) => (Array.isArray(value) ? value.join('; ') : value || '');
const formatDate = (value) => (value ? new Date(value).toISOString() : '');

/** Flatten a lead document into a plain export row. */
function toExportRow(lead) {
  const obj = typeof lead.toObject === 'function' ? lead.toObject() : lead;
  const ev = obj.emailValidation || {};
  const row = {};
  EXPORT_COLUMNS.forEach(({ key }) => {
    let value = obj[key];
    if (key === 'publicEmails' || key === 'publicPhones' || key === 'services' || key === 'aiTags') {
      value = joinList(value);
    } else if (key === 'scrapedAt') {
      value = formatDate(value);
    } else if (key === 'emailConfidence') {
      value = ev.confidence !== undefined ? ev.confidence : '';
    } else if (key === 'emailSyntaxValid') {
      value = ev.syntaxValid !== undefined ? (ev.syntaxValid ? 'yes' : 'no') : '';
    } else if (key === 'emailDomainExists') {
      value = ev.domainExists !== undefined ? (ev.domainExists ? 'yes' : 'no') : '';
    } else if (key === 'emailMxFound') {
      value = ev.mxFound !== undefined ? (ev.mxFound ? 'yes' : 'no') : '';
    } else if (key === 'emailDisposable') {
      value = ev.disposable !== undefined ? (ev.disposable ? 'yes' : 'no') : '';
    } else if (key === 'emailRoleBased') {
      value = ev.roleBased !== undefined ? (ev.roleBased ? 'yes' : 'no') : '';
    } else if (key === 'emailSmtpResult') {
      value = ev.smtpResult !== undefined ? ev.smtpResult : '';
    } else if (key === 'emailReason') {
      value = ev.reason || '';
    }
    row[key] = value === undefined || value === null ? '' : value;
  });
  return row;
}

async function distinctValues(userId, field) {
  if (!['category', 'city', 'state', 'source'].includes(field)) return [];
  const values = await Lead.distinct(field, { user: userId });
  return values.filter(Boolean).sort();
}

module.exports = {
  EXPORT_COLUMNS,
  buildLeadQuery,
  buildSort,
  distinctValues,
  getLead,
  iterateLeads,
  listLeads,
  toExportRow,
};
