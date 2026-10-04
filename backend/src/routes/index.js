'use strict';

/** Root API router: mounts every feature router under /api. */

const express = require('express');
const rateLimiters = require('../middleware/rateLimiters');
const authRoutes = require('./authRoutes');
const internalRoutes = require('./internalRoutes');
const jobRoutes = require('./jobRoutes');
const leadRoutes = require('./leadRoutes');
const miscRoutes = require('./miscRoutes');

const router = express.Router();

router.use(rateLimiters.apiLimiter);

// Service-to-service progress webhook (shared internal token).
router.use('/internal', internalRoutes);

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'leadforge-api', time: new Date().toISOString() });
});

// Feature routers
router.use('/auth', authRoutes);
router.use('/jobs', jobRoutes);
router.use('/leads', leadRoutes);
router.use('/', miscRoutes); // dashboard, lists, exports, settings

module.exports = router;