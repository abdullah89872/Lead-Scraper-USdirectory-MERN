'use strict';

const express = require('express');
const dashboardController = require('../controllers/dashboardController');
const listController = require('../controllers/listController');
const settingsController = require('../controllers/settingsController');
const exportHistoryController = require('../controllers/exportHistoryController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Auth is applied per route rather than with `router.use`, so an unknown path
// still falls through to the global 404 handler instead of a misleading 401.

/** GET /api/dashboard/stats */
router.get('/dashboard/stats', requireAuth, dashboardController.stats);

// ---- Lists -----------------------------------------------------------------
// GET /api/lists
router.get('/lists', requireAuth, listController.list);
// POST /api/lists
router.post('/lists', requireAuth, listController.create);
// GET /api/lists/:id
router.get('/lists/:id', requireAuth, listController.getOne);
// PATCH /api/lists/:id
router.patch('/lists/:id', requireAuth, listController.update);
// DELETE /api/lists/:id
router.delete('/lists/:id', requireAuth, listController.remove);

// ---- Export history --------------------------------------------------------
// GET /api/exports
router.get('/exports', requireAuth, exportHistoryController.list);
// DELETE /api/exports/:id
router.delete('/exports/:id', requireAuth, exportHistoryController.remove);

// ---- Settings --------------------------------------------------------------
// GET /api/settings
router.get('/settings', requireAuth, settingsController.read);

module.exports = router;