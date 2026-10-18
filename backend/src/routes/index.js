'use strict';

/** Root API router: mounts every feature router under /api. */

const express = require('express');
const mongoose = require('mongoose');
const rateLimiters = require('../middleware/rateLimiters');
const authRoutes = require('./authRoutes');
const internalRoutes = require('./internalRoutes');
const jobRoutes = require('./jobRoutes');
const leadRoutes = require('./leadRoutes');
const listRoutes = require('./listRoutes');
const miscRoutes = require('./miscRoutes');

const router = express.Router();

router.use(rateLimiters.apiLimiter);

router.get('/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  return res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'unavailable',
    service: 'leadforge-api',
    database: connected ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
});

// Service-to-service progress webhook (shared internal token).
router.use('/internal', internalRoutes);

// Feature routers
router.use('/auth', authRoutes);
router.use('/jobs', jobRoutes);
router.use('/leads', leadRoutes);
router.use('/lists', listRoutes);
router.use('/', miscRoutes); // dashboard, exports, validation, settings

module.exports = router;