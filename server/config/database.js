'use strict';
// Single place that decides which database to connect to. Used by config/config.js
// (Sequelize + migrations) and config/session.js (the session store's own pool).
//
// Tests NEVER touch your development data: when NODE_ENV=test the database is
// TEST_DATABASE_URL, or DB_NAME_TEST, or "<DB_NAME>_test".
require('dotenv').config({ quiet: true });

function resolveDatabase(nodeEnv = process.env.NODE_ENV || 'development') {
  const isTest = nodeEnv === 'test';
  const urlVar = isTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL';
  const ssl = process.env.DB_SSL === 'true';

  if (process.env[urlVar]) return { urlVar, url: process.env[urlVar], ssl };

  const database = isTest
    ? process.env.DB_NAME_TEST || (process.env.DB_NAME ? `${process.env.DB_NAME}_test` : undefined)
    : process.env.DB_NAME;

  return {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    ssl,
  };
}

// Options for a plain `pg` Pool (used by the session store).
function pgPoolOptions(nodeEnv) {
  const db = resolveDatabase(nodeEnv);
  const ssl = db.ssl ? { rejectUnauthorized: false } : undefined;
  if (db.url) return { connectionString: db.url, ssl, max: 5 };
  return {
    user: db.user,
    password: db.password,
    database: db.database,
    host: db.host,
    port: db.port,
    ssl,
    max: 5,
  };
}

module.exports = { resolveDatabase, pgPoolOptions };
