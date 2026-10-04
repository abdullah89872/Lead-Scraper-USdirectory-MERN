'use strict';

/** CSV / XLSX export of the filtered (or explicitly selected) lead set. */

const { asyncHandler } = require('../middleware/validate');
const { recordExport, streamCsv, streamXlsx } = require('../services/exportService');

function runExport(streamFn, req, res) {
  return asyncHandler(async (_req, _res) => {
    // `req.query` is reused verbatim, so "export what I am looking at" is the
    // default behaviour of both endpoints.
    const { id, format, fileName, count, bytes } = await streamFn({
      user: req.user._id,
      query: req.query,
      res,
      onFinish: (info) =>
        recordExport({ user: req.user._id, format: id, query: req.query, ...info }),
    });
    req.log?.info?.({ format: id, count, bytes, fileName }, 'export completed');
    return undefined;
  })(req, res, () => {});
}

const csv = (req, res) =>
  runExport(streamCsv, req, res);

const xlsx = (req, res) =>
  runExport(streamXlsx, req, res);

module.exports = { csv, xlsx };