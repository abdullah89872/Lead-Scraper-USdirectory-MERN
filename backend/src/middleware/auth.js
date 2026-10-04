'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const logger = require('../config/logger');

/** Sign a JWT for a user document. */
function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, email: user.email },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

/** Bearer-token authentication middleware. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');

  if (!token || !header.toLowerCase().startsWith('bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    req.auth = payload;
    return next();
  } catch (error) {
    logger.debug({ err: error.message }, 'jwt verification failed');
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/** Role guard - use after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this resource' });
    }
    return next();
  };
}

/** Shared-secret guard for internal calls (scraper progress webhook). */
function requireInternalToken(req, res, next) {
  const token = req.headers['x-internal-token'];
  if (!token || token !== env.internalApiToken) {
    return res.status(401).json({ error: 'Invalid internal token' });
  }
  return next();
}

module.exports = { requireAuth, requireInternalToken, requireRole, signToken };
