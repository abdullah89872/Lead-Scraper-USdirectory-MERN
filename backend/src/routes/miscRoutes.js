'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const dashboardController = require('../controllers/dashboardController');
const exportController = require('../controllers/exportController');
const settingsController = require('../controllers/settingsController');
const emailValidationController = require('../controllers/emailValidationController');
const { requireAuth } = require('../middleware/auth');
const rateLimiters = require('../middleware/rateLimiters');

const router = express.Router();

// Temp storage for CSV uploads (cleaned up by the controller after parsing).
const upload = multer({
  dest: path.join(os.tmpdir(), 'leadforge-validation-uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB default; env can override
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.csv' || ext === '.txt') return cb(null, true);
    cb(new Error('Only .csv or .txt files are allowed'));
  },
});

// Auth is applied per route rather than with `router.use`, so an unknown path
// still falls through to the global 404 handler instead of a misleading 401.

/** GET /api/dashboard/stats */
router.get('/dashboard/stats', requireAuth, dashboardController.stats);

// ---- Email validation ------------------------------------------------------
// POST /api/validate/emails - legacy path for background email-list validation.
router.post(
  '/validate/emails',
  requireAuth,
  rateLimiters.validationLimiter,
  emailValidationController.validateEmailList
);

// POST /api/validate/email-list - queue SMTP-capable list validation.
router.post(
  '/validate/email-list',
  requireAuth,
  rateLimiters.validationLimiter,
  emailValidationController.validateEmailList
);

// POST /api/validate/leads - kick off a background validation job for leads
//   matching a filter or id list.
router.post(
  '/validate/leads',
  requireAuth,
  rateLimiters.validationLimiter,
  emailValidationController.validateLeads
);

// POST /api/validate/csv - validate an uploaded CSV file (background job).
router.post(
  '/validate/csv',
  requireAuth,
  rateLimiters.validationLimiter,
  upload.single('file'),
  emailValidationController.validateCsv
);

// GET /api/validate/jobs - list validation jobs for the current user.
router.get(
  '/validate/jobs',
  requireAuth,
  emailValidationController.listValidationJobs
);

// GET /api/validate/jobs/:id - get a single validation job.
router.get(
  '/validate/jobs/:id',
  requireAuth,
  emailValidationController.getValidationJob
);

// GET /api/validate/jobs/:id/results - get paginated validation results.
router.get(
  '/validate/jobs/:id/results',
  requireAuth,
  emailValidationController.getValidationResults
);

// POST /api/validate/jobs/:id/cancel - cancel a running/queued job.
router.post(
  '/validate/jobs/:id/cancel',
  requireAuth,
  emailValidationController.cancelValidationJob
);

// GET /api/validate/jobs/:id/export/valid-leads.csv
router.get(
  '/validate/jobs/:id/export/valid-leads.csv',
  requireAuth,
  emailValidationController.exportValidCsvLeads
);

// GET /api/validate/jobs/:id/export/csv - export validation results as CSV.
router.get(
  '/validate/jobs/:id/export/csv',
  requireAuth,
  emailValidationController.exportValidationCsv
);

// GET /api/validate/settings - validation configuration + list info.
router.get('/validate/settings', requireAuth, emailValidationController.getValidationSettings);

// ---- Export history --------------------------------------------------------
// GET /api/exports - audit trail of CSV/XLSX downloads (newest first).
router.get('/exports', requireAuth, exportController.list);

// ---- Settings --------------------------------------------------------------
// GET /api/settings
router.get('/settings', requireAuth, settingsController.read);

module.exports = router;
