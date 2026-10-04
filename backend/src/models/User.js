'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    lastLoginAt: { type: Date, default: null },
    settings: {
      defaultSource: { type: String, default: 'usdirectory' },
      defaultMaxLeads: { type: Number, default: 100, min: 1, max: 1000 },
      defaultEnrichment: { type: Boolean, default: true },
      defaultAi: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

/** Hash a plaintext password with bcrypt. */
userSchema.statics.hashPassword = async function hashPassword(plain) {
  const rounds = Math.max(4, env.bcryptRounds);
  return bcrypt.hash(plain, rounds);
};

userSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
    settings: this.settings,
    createdAt: this.createdAt,
    lastLoginAt: this.lastLoginAt,
  };
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
