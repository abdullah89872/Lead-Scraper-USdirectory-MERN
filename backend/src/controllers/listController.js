'use strict';

/** Saved lead lists (dashboard "Lists" page). */

const mongoose = require('mongoose');
const { asyncHandler } = require('../middleware/validate');
const Lead = require('../models/Lead');
const LeadList = require('../models/LeadList');

/** GET /api/lists */
const list = asyncHandler(async (req, res) => {
  const items = await LeadList.find({ user: req.user._id }).sort({ updatedAt: -1 });
  return res.json({ lists: items.map((item) => item.toJSON()) });
});

/** POST /api/lists - create a list from lead ids or from a filtered query. */
const create = asyncHandler(async (req, res) => {
  const { name, description, leadIds, filters } = req.body;

  let leads = [];
  if (Array.isArray(leadIds) && leadIds.length) {
    leads = await Lead.find({
      user: req.user._id,
      _id: { $in: leadIds.filter((id) => mongoose.isValidObjectId(id)) },
    }).select('_id');
  } else if (filters) {
    const { buildLeadQuery } = require('../services/leadService');
    leads = await Lead.find(await buildLeadQuery(req.user._id, filters)).select('_id').limit(5000);
  }

  const doc = await LeadList.create({
    user: req.user._id,
    name,
    description: description || null,
    leads: leads.map((lead) => lead._id),
  });
  return res.status(201).json({ list: doc.toJSON() });
});

/** GET /api/lists/:id */
const getOne = asyncHandler(async (req, res) => {
  const doc = await LeadList.findOne({ _id: req.params.id, user: req.user._id });
  if (!doc) return res.status(404).json({ error: 'List not found' });
  return res.json({ list: doc.toJSON() });
});

/** PATCH /api/lists/:id - rename or replace the contents. */
const update = asyncHandler(async (req, res) => {
  const doc = await LeadList.findOne({ _id: req.params.id, user: req.user._id });
  if (!doc) return res.status(404).json({ error: 'List not found' });

  if (req.body.name !== undefined) doc.name = req.body.name;
  if (req.body.description !== undefined) doc.description = req.body.description;
  if (Array.isArray(req.body.leadIds)) {
    const allowed = await Lead.find({
      user: req.user._id,
      _id: { $in: req.body.leadIds.filter((id) => mongoose.isValidObjectId(id)) },
    }).select('_id');
    doc.leads = allowed.map((lead) => lead._id);
  }
  await doc.save();
  return res.json({ list: doc.toJSON() });
});

/** DELETE /api/lists/:id - deletes the list only, never the leads. */
const remove = asyncHandler(async (req, res) => {
  const doc = await LeadList.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!doc) return res.status(404).json({ error: 'List not found' });
  return res.json({ deleted: true, id: req.params.id });
});

module.exports = { create, getOne, list, remove, update };