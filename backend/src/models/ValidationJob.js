'use strict';

/**
 * ValidationJob — persistent record of a background email-validation run.
 *
 * Covers both modes from the spec:
 *   - `leads`  : validate previously extracted leads (by filter or id list)
 *   - `csv`    : validate an uploaded CSV (stored under a job-scoped file)
 *
 * Progress is written to MongoDB so SSE/polling status works across API
 * instances. Restarts are explicit: a job left `running` when the process
 * boots is marked `interrupted` so it can be resumed or retried by the user
 * instead of silently re-running work.
 */

const mongoose = require('mongoose');

const JOB_TYPES = ['leads', 'csv', 'email-list'];
const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];

const validationJobSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: JOB_TYPES, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'queued', index: true },

    // Input selection
    leadIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    leadFilter: { type: mongoose.Schema.Types.Mixed, default: {} },
    emailColumn: { type: String, default: null },
    sourceFileName: { type: String, default: null },
    inputEmails: { type: [String], default: [], select: false },
    // Absolute path of the stored upload (server-side only, never serialized).
    inputFile: { type: String, default: null, select: false },

    options: {
      batchSize: { type: Number, default: 200 },
      concurrency: { type: Number, default: 10 },
    },

    progress: {
      stage: { type: String, default: 'queued' },
      percent: { type: Number, default: 0, min: 0, max: 100 },
      message: { type: String, default: null },
      total: { type: Number, default: 0 },
      processed: { type: Number, default: 0 },
      updatedAt: { type: Date, default: Date.now },
    },

    summary: {
      total: { type: Number, default: 0 },
      unique: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      valid: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      risky: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      error: { type: Number, default: 0 },
      cacheHits: { type: Number, default: 0 },
    },

    // Per-address results for CSV jobs (row index -> outcome). Leads jobs read
    // results back off the Lead documents instead.
    results: { type: mongoose.Schema.Types.Mixed, default: [] },

    error: { type: String, default: null },
    cancelRequested: { type: Boolean, default: false },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

validationJobSchema.index({ user: 1, createdAt: -1 });
validationJobSchema.index({ status: 1, createdAt: -1 });

validationJobSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  if (obj.user) obj.user = obj.user.toString();
  if (Array.isArray(obj.leadIds)) obj.leadIds = obj.leadIds.map((id) => String(id));
  delete obj.inputFile;
  delete obj.inputEmails;
  // Cap inline results in list views; the detail endpoint paginates.
  if (Array.isArray(obj.results) && obj.results.length > 200) {
    obj.results = obj.results.slice(0, 200);
    obj.resultsTruncated = true;
  }
  return obj;
};

validationJobSchema.statics.JOB_TYPES = JOB_TYPES;
validationJobSchema.statics.STATUSES = JOB_STATUSES;

module.exports =
  mongoose.models.ValidationJob || mongoose.model('ValidationJob', validationJobSchema);
