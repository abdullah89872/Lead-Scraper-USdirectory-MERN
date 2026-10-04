'use strict';

const { z } = require('zod');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const rateLimiters = require('../middleware/rateLimiters');
const exportController = require('../controllers/exportController');
const leadController = require('../controllers/leadController');

const router = express.Router();

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(2).optional(),
  source: z.string().trim().max(60).optional(),
  job: z.string().trim().max(64).optional(),
  list: z.string().trim().max(64).optional(),
  emailStatus: z.enum(['valid', 'invalid', 'unknown']).optional(),
  enrichmentStatus: z
    .enum(['not_attempted', 'completed', 'no_website', 'failed', 'skipped'])
    .optional(),
  hasEmail: booleanish.optional(),
  hasPhone: booleanish.optional(),
  hasWebsite: booleanish.optional(),
  ids: z.string().trim().max(20000).optional(),
  sort: z.string().trim().max(40).default('-createdAt'),
});

// The same filter set drives the table and both exports, so the schema is shared.
const filterQuery = listSchema.partial({ page: true, limit: true, sort: true });

router.use(requireAuth);

// GET /api/leads/export/csv  (declared before "/:id" so "export" is not read as an id)
router.get('/export/csv', rateLimiters.exportLimiter, validate({ query: filterQuery }), exportController.csv);

// GET /api/leads/export/xlsx
router.get(
  '/export/xlsx',
  rateLimiters.exportLimiter,
  validate({ query: filterQuery }),
  exportController.xlsx
);

// GET /api/leads/meta/filters
router.get('/meta/filters', leadController.filters);

// GET /api/leads
router.get('/', validate({ query: listSchema }), leadController.list);

// POST /api/leads/bulk-delete
router.post('/bulk-delete', leadController.bulkDelete);

// GET /api/leads/:id
router.get('/:id', leadController.getOne);

// DELETE /api/leads/:id
router.delete('/:id', leadController.remove);

module.exports = router;