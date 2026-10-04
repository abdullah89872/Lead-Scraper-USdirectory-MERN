'use strict';

const mongoose = require('mongoose');

const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];

const jobSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    source: { type: String, required: true, default: 'usdirectory', trim: true },
    category: { type: String, required: true, trim: true, maxlength: 120 },
    location: { type: String, required: true, trim: true, maxlength: 160 },
    maxLeads: { type: Number, required: true, min: 1, max: 1000, default: 100 },
    enrichment: { type: Boolean, default: true },
    ai: { type: Boolean, default: false },
    mode: { type: String, enum: ['mock', 'live'], default: 'mock' },

    status: { type: String, enum: JOB_STATUSES, default: 'queued', index: true },
    progress: {
      stage: { type: String, default: 'queued' },
      percent: { type: Number, default: 0, min: 0, max: 100 },
      message: { type: String, default: null },
      leadsFound: { type: Number, default: 0 },
      updatedAt: { type: Date, default: Date.now },
    },

    leadsCount: { type: Number, default: 0 },
    duplicatesMerged: { type: Number, default: 0 },
    possibleDuplicates: { type: Number, default: 0 },
    error: { type: String, default: null },
    warnings: { type: [String], default: [] },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },

    queueDriver: { type: String, default: null },
    cancelRequested: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ user: 1, createdAt: -1 });
jobSchema.index({ status: 1, createdAt: -1 });

jobSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject({ virtuals: true });
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  if (obj.user && typeof obj.user === 'object' && obj.user._id) {
    obj.user = {
      id: obj.user._id.toString(),
      name: obj.user.name,
      email: obj.user.email,
    };
  } else if (obj.user) {
    obj.user = obj.user.toString();
  }
  return obj;
};

jobSchema.statics.STATUSES = JOB_STATUSES;

module.exports = mongoose.models.Job || mongoose.model('Job', jobSchema);
