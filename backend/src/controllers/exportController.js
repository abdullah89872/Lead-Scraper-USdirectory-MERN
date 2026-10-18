'use strict';

/** CSV / XLSX export of the filtered (or explicitly selected) lead set. */

const { asyncHandler } = require('../middleware/validate');
const ExportRecord = require('../models/ExportRecord');
const { recordExport, streamCsv, streamXlsx } = require('../services/exportService');

function runExport(streamFn, format, req, res) {
  return asyncHandler(async (_req, _res) => {
    // `req.query` is reused verbatim, so "export what I am looking at" is the
    // default behaviour of both endpoints.
    const { fileName, count, bytes } = await streamFn({
      user: req.user._id,
      query: req.query,
      res,
      onFinish: (info) =>
        recordExport({ user: req.user._id, format, query: req.query, ...info }),
    });
    req.log?.info?.({ format, count, bytes, fileName }, 'export completed');
    return undefined;
  })(req, res, () => {});
}

const csv = (req, res) =>
  runExport(streamCsv, 'csv', req, res);

const xlsx = (req, res) =>
  runExport(streamXlsx, 'xlsx', req, res);

/** GET /api/exports - the caller's export download history (newest first). */
const list = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

  const filter = { user: req.user._id };
  const [items, total] = await Promise.all([
    ExportRecord.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    ExportRecord.countDocuments(filter),
  ]);

  return res.json({
    exports: items.map((record) => record.toJSON()),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
});

module.exports = { csv, list, xlsx };