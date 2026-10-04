'use strict';

/** Express application factory (kept separate so tests can import it directly). */

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const routes = require('./routes');
const env = require('./config/env');
const logger = require('./config/logger');
const { errorHandler, notFound } = require('./middleware/validate');

function createApp() {
  const app = express();

  // Behind a proxy in production so req.ip / rate limiting stay accurate.
  if (env.isProduction) app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON and file downloads only, so a strict CSP would
      // only get in the way; the dashboard sets its own CSP headers.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin: env.clientOrigin.split(',').map((value) => value.trim()),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.get('/', (req, res) => {
    res.json({
      name: 'LeadForge AI API',
      version: '1.0.0',
      mode: env.isMock ? 'mock' : 'live',
      docs: '/api/health',
    });
  });

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };