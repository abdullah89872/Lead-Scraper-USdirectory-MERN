'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');

/**
 * Cache for AI responses. Keyed by a hash of (task + input) so identical
 * requests never hit the OpenAI API twice.
 */
const aiCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    task: { type: String, required: true },
    model: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + env.aiCacheTtlDays * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

// TTL index: Mongo removes expired cache entries automatically.
aiCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.AiCache || mongoose.model('AiCache', aiCacheSchema);
