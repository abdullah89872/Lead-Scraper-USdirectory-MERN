'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDb, disconnectDb } = require('../db/connect');

async function main() {
  try {
    await connectDb();
    await mongoose.connection.db.admin().command({ ping: 1 });
    console.log(`MongoDB connection verified (database: ${env.mongodbDbName}).`);
  } finally {
    await disconnectDb();
  }
}

main().catch((error) => {
  console.error(`MongoDB connection check failed: ${error.message}`);
  process.exitCode = 1;
});
