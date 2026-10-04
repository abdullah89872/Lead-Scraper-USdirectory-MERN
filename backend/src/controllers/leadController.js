'use strict';

const mongoose = require('mongoose');
const { asyncHandler } = require('../middleware/validate');
const Lead = require('../models/Lead');
const { distinctValues, getLead, listLeads } = require('../services/leadService');

/** GET /api/leads - searchable, filterable, paginated. */
const list = asyncHandler(async (req, res) => {
  const { items, total, page, limit, pages } = await listLeads(req.user._id, req.query);
  return res.json({
    leads: items.map((lead) => lead.toJSON()),
    pagination: { page, limit, total, pages },
  });
});

/** GET /api/leads/:id */
const getOne = asyncHandler(async (req, res) => {
  const lead = await getLead(req.user._id, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  return res.json({ lead: lead.toJSON() });
});

/** DELETE /api/leads/:id */
const remove = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid lead id' });
  }
  const lead = await Lead.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  return res.json({ deleted: true, id: req.params.id });
});

/** POST /api/leads/bulk-delete */
const bulkDelete = asyncHandler(async (req, res) => {
  const ids = (req.body.ids || [])
    .map((id) => String(id))
    .filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return res.status(400).json({ error: 'No valid lead ids supplied' });

  const result = await Lead.deleteMany({ _id: { $in: ids }, user: req.user._id });
  return res.json({ deleted: result.deletedCount, requested: ids.length });
});

/** GET /api/leads/meta/filters - values available for the filter dropdowns. */
const filters = asyncHandler(async (req, res) => {
  const [categories, cities, states, sources] = await Promise.all([
    distinctValues(req.user._id, 'category'),
    distinctValues(req.user._id, 'city'),
    distinctValues(req.user._id, 'state'),
    distinctValues(req.user._id, 'source'),
  ]);
  return res.json({ categories, cities, states, sources });
});

module.exports = { bulkDelete, filters, getOne, list, remove };