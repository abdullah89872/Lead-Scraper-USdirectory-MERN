'use strict';

const { ZodError } = require('zod');
const mongoose = require('mongoose');

const DATABASE_UNAVAILABLE_ERRORS = new Set([
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
  'MongoPoolClearedError',
]);

/** Validate req.body / req.query / req.params against a zod schema map. */
function validate(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) req.query = schemas.query.parse(req.query ?? {});
      if (schemas.params) req.params = schemas.params.parse(req.params ?? {});
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/** 404 handler. */
function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

/** Central error handler producing consistent JSON errors. */
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (error && error.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation failed',
      details: Object.values(error.errors || {}).map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({ error: 'A record with those details already exists' });
  }

  const mongooseDisconnectedError = error?.name === 'MongooseError'
    && mongoose.connection.readyState !== 1;
  if (DATABASE_UNAVAILABLE_ERRORS.has(error?.name) || mongooseDisconnectedError) {
    req.log?.error?.({ errorName: error.name, code: error.code }, 'database temporarily unavailable');
    return res.status(503).json({ error: 'Database is temporarily unavailable. Please retry shortly.' });
  }

  const status = error.status || error.statusCode || 500;
  if (status >= 500) {
    req.log?.error?.({ err: error.message, stack: error.stack }, 'request failed');
  }
  return res.status(status).json({ error: error.message || 'Something went wrong' });
}

/** Wrap async route handlers so rejections reach the error handler. */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { asyncHandler, errorHandler, notFound, validate };
