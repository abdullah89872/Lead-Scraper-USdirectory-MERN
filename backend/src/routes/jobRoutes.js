'use strict';

const { z } = require('zod');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const rateLimiters = require('../middleware/rateLimiters');
const jobController = require('../controllers/jobController');
const progressController = require('../controllers/progressController');

const router = express.Router();

router.use(requireAuth);

const createJobSchema = z.object({
  source: z.string().trim().min(1).max(60).default('usdirectory'),
  category: z
    .string()
    .trim()
    .min(2, 'Category must be at least 2 characters')
    .max(120, 'Category is too long'),
  location: z
    .string()
    .trim()
    .min(2, 'Location must be at least 2 characters')
    .max(160, 'Location is too long'),
  maxLeads: z.coerce
    .number()
    .int('Maximum leads must be a whole number')
    .min(1, 'Maximum leads must be at least 1')
    .max(1000, 'Maximum leads cannot exceed 1000')
    .default(100),
  enrichment: z.coerce.boolean().default(true),
  ai: z.coerce.boolean().default(false),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
});

// POST /api/jobs
router.post('/', rateLimiters.jobLimiter, validate({ body: createJobSchema }), jobController.create);

// GET /api/jobs/meta/statuses  (declared before "/:id" so it is not swallowed)
router.get('/meta/statuses', jobController.statuses);

// GET /api/jobs
router.get('/', validate({ query: listSchema }), jobController.list);

// GET /api/jobs/:id/progress  (SSE) - the handler does its own ownership check.
router.get('/:id/progress', progressController.stream);

// GET /api/jobs/:id
router.get('/:id', jobController.getOne);

// POST /api/jobs/:id/cancel
router.post('/:id/cancel', jobController.cancel);

// DELETE /api/jobs/:id
router.delete('/:id', jobController.remove);

module.exports = router;