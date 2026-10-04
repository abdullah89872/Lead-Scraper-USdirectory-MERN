'use strict';

const pino = require('pino');
const env = require('./env');

/** Structured JSON logging (pretty printed in development). */
const logger = pino({
  level: env.isTest ? 'silent' : env.logLevel,
  base: { service: 'leadforge-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
