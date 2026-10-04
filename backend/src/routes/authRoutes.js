'use strict';

const { z } = require('zod');
const express = require('express');
const rateLimiters = require('../middleware/rateLimiters');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const authController = require('../controllers/authController');

const router = express.Router();

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  settings: z
    .object({
      defaultMaxLeads: z.number().int().min(1).max(1000).optional(),
      defaultEnrichment: z.boolean().optional(),
      defaultAi: z.boolean().optional(),
    })
    .partial()
    .optional(),
});

// POST /api/auth/register
router.post('/register', rateLimiters.authLimiter, validate({ body: registerSchema }), authController.register);

// POST /api/auth/login
router.post('/login', rateLimiters.authLimiter, validate({ body: loginSchema }), authController.login);

// POST /api/auth/logout
router.post('/logout', requireAuth, authController.logout);

// GET /api/auth/me
router.get('/me', requireAuth, authController.me);

// PATCH /api/auth/me
router.patch('/me', requireAuth, validate({ body: profileSchema }), authController.updateProfile);

module.exports = router;