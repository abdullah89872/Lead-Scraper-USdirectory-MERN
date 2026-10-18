'use strict';

const mongoose = require('mongoose');

const EMAIL_STATUSES = ['valid', 'invalid', 'risky', 'unknown', 'pending', 'error'];
const LEGACY_EMAIL_STATUSES = ['valid', 'invalid', 'unknown'];
const ENRICHMENT_STATUSES = [
  'not_attempted',
  'completed',
  'no_website',
  'failed',
  'skipped',
];

const leadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null, index: true },

    // ---- source fields (never fabricated: missing values stay null) ----
    businessName: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, default: null, trim: true },
    description: { type: String, default: null, trim: true, maxlength: 4000 },
    address: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true, index: true },
    state: { type: String, default: null, trim: true, uppercase: true, maxlength: 2 },
    zip: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
    website: { type: String, default: null, trim: true },
    source: { type: String, required: true, default: 'usdirectory', index: true },
    sourceUrl: { type: String, required: true, trim: true, index: true },
    sourceId: { type: String, default: null, trim: true },
    contactPageUrl: { type: String, default: null, trim: true },
    publicEmails: { type: [String], default: [] },
    publicPhones: { type: [String], default: [] },
    services: { type: [String], default: [] },

    // ---- AI-generated fields, kept strictly separate from source data ----
    aiCategory: { type: String, default: null },
    aiServices: { type: [String], default: [] },
    aiTags: { type: [String], default: [] },
    aiDescription: { type: String, default: null },
    aiGeneratedAt: { type: Date, default: null },

    // ---- metadata ----
    emailStatus: { type: String, enum: EMAIL_STATUSES, default: 'unknown', index: true },
    // Full pipeline evidence (syntax/DNS/SMTP). Optional so legacy docs stay valid.
    emailValidation: {
      status: { type: String, enum: EMAIL_STATUSES, default: undefined },
      confidence: { type: Number, min: 0, max: 100, default: undefined },
      syntaxValid: { type: Boolean, default: undefined },
      domainExists: { type: Boolean, default: undefined },
      mxFound: { type: Boolean, default: undefined },
      mxFallbackUsed: { type: Boolean, default: undefined },
      disposable: { type: Boolean, default: undefined },
      roleBased: { type: Boolean, default: undefined },
      freeProvider: { type: Boolean, default: undefined },
      catchAllSuspected: { type: Boolean, default: undefined },
      smtpAttempted: { type: Boolean, default: undefined },
      smtpResult: {
        type: String,
        enum: ['accepted', 'rejected', 'inconclusive', 'blocked', 'temp_failed', 'unavailable', 'not_attempted', 'error'],
        default: undefined,
      },
      smtpCode: { type: String, default: undefined },
      reason: { type: String, default: undefined, maxlength: 500 },
      validatedAt: { type: Date, default: undefined },
      fromCache: { type: Boolean, default: undefined },
    },
    enrichmentStatus: {
      type: String,
      enum: ENRICHMENT_STATUSES,
      default: 'not_attempted',
      index: true,
    },
    enrichmentSources: { type: [String], default: [] },
    demoData: { type: Boolean, default: false, index: true },
    possibleDuplicate: { type: Boolean, default: false },
    duplicateReason: { type: String, default: null },
    notes: { type: [String], default: [] },
    scrapedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

leadSchema.index({ user: 1, createdAt: -1 });
leadSchema.index({ user: 1, sourceUrl: 1 });
leadSchema.index({ user: 1, email: 1 });
leadSchema.index({ user: 1, phone: 1 });
leadSchema.index({ user: 1, businessName: 1 });
leadSchema.index({ user: 1, emailStatus: 1, createdAt: -1 });

leadSchema.virtual('location').get(function location() {
  return [this.city, this.state].filter(Boolean).join(', ') || null;
});

leadSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject({ virtuals: true });
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  if (obj.user) obj.user = obj.user.toString();
  if (obj.job) obj.job = obj.job.toString();
  return obj;
};

leadSchema.statics.EMAIL_STATUSES = EMAIL_STATUSES;
leadSchema.statics.LEGACY_EMAIL_STATUSES = LEGACY_EMAIL_STATUSES;
leadSchema.statics.ENRICHMENT_STATUSES = ENRICHMENT_STATUSES;

module.exports = mongoose.models.Lead || mongoose.model('Lead', leadSchema);
