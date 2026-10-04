'use strict';

const mongoose = require('mongoose');

/** A saved, named collection of leads (dashboard "Lists" page). */
const leadListSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: null, trim: true, maxlength: 500 },
    leads: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lead' }],
  },
  { timestamps: true }
);

leadListSchema.index({ user: 1, name: 1 }, { unique: true });

leadListSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  obj.user = obj.user.toString();
  obj.leadCount = Array.isArray(obj.leads) ? obj.leads.length : 0;
  return obj;
};

module.exports = mongoose.models.LeadList || mongoose.model('LeadList', leadListSchema);
