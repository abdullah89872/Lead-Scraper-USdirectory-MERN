'use strict';

/**
 * Internal (service-to-service) routes.
 *
 * Guarded by the shared internal token, never by a user JWT: these endpoints are
 * only called by the Python scraper to report live progress.
 */

const express = require('express');
const internalController = require('../controllers/internalController');
const { requireInternalToken } = require('../middleware/auth');

const router = express.Router();

router.use(requireInternalToken);

// POST /api/internal/jobs/:id/progress
router.post('/jobs/:id/progress', internalController.report);

module.exports = router;