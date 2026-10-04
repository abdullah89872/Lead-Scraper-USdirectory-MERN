'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** POST /api/auth/register */
async function register(req, res) {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const isFirstUser = (await User.estimatedDocumentCount()) === 0;
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    passwordHash: await User.hashPassword(password),
    role: isFirstUser ? 'admin' : 'user',
  });

  logger.info({ userId: user.id, role: user.role }, 'user registered');
  return res.status(201).json({ token: signToken(user), user: user.toPublicJSON() });
}

/** POST /api/auth/login */
async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');

  if (!user || !(await user.verifyPassword(password))) {
    // Same message for both cases: no account enumeration.
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  user.lastLoginAt = new Date();
  await user.save();

  return res.json({ token: signToken(user), user: user.toPublicJSON() });
}

/** POST /api/auth/logout - stateless JWT, so this is a client-side discard. */
async function logout(req, res) {
  // Tokens are stateless; the client drops the token. Kept for API symmetry and
  // so a future denylist can be added without changing the contract.
  return res.json({ success: true, message: 'Signed out' });
}

/** GET /api/auth/me */
async function me(req, res) {
  return res.json({ user: req.user.toPublicJSON() });
}

/** PATCH /api/auth/me - update profile / default scrape settings. */
async function updateProfile(req, res) {
  const { name, settings } = req.body;
  if (name) req.user.name = name;
  if (settings) {
    req.user.settings = {
      ...req.user.settings.toObject?.() ?? req.user.settings,
      ...settings,
    };
  }
  await req.user.save();
  return res.json({ user: req.user.toPublicJSON() });
}

module.exports = { EMAIL_RE, login, logout, me, register, updateProfile, env };
