'use strict';

const mongoose = require('mongoose');

/** Audit trail of server-side export jobs (CSV/XLSX). */
const exportRecordSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    format: { type: String, enum: ['csv', 'xlsx'], required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    leadCount: { type: Number, default: 0 },
    fileName: { type: String, default: null },
    bytes: { type: Number, default: 0 },
    status: { type: String, enum: ['completed', 'failed'], default: 'completed' },
  },
  { timestamps: true }
);

exportRecordSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  obj.user = obj.user.toString();
  return obj;
};

module.exports =
  mongoose.models.ExportRecord || mongoose.model('ExportRecord', exportRecordSchema);
