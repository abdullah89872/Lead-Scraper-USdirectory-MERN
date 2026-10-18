'use strict';

const express = require('express');
const { z } = require('zod');
const listController = require('../controllers/listController');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

const leadIdsSchema = z.array(z.string().trim().min(1).max(64)).max(5000);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  leadIds: leadIdsSchema.optional(),
  filters: z.record(z.unknown()).optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  leadIds: leadIdsSchema.optional(),
});

router.use(requireAuth);

router.get('/', listController.list);
router.post('/', validate({ body: createSchema }), listController.create);
router.get('/:id', listController.getOne);
router.patch('/:id', validate({ body: updateSchema }), listController.update);
router.delete('/:id', listController.remove);

module.exports = router;
