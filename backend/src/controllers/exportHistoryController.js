'use strict';

/** Export history ("Exports" page). */

const { asyncHandler } = require('../middleware/validate');
const ExportRecord = require('../models/ExportRecord');

/** GET /api/exports - recent export runs for the current user. */
const list = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const items = await ExportRecord.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .limit(limit);
  return res.json({ exports: items.map((item) => item.toJSON()) });
});

/** DELETE /api/exports/:id - removes the audit row only. */
const remove = asyncHandler(async (req, res) => {
  const record = await ExportRecord.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!record) return res.status(404).json({ error: 'Export not found' });
  return res.json({ deleted: true, id: req.params.id });
});

module.exports = { list, remove };