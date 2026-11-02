'use strict';
// Server-side sessions stored in PostgreSQL (SC#5, SC#12, SC#13).
//
// - The browser only holds an opaque, signed session id in an HttpOnly cookie.
// - The cookie and the database row both expire after an idle period (30 min for
//   students, 15 min for administrators). Every request moves that deadline forward
//   ("rolling"), so only inactivity ends a session.
// - Deleting rows from the `sessions` table logs people out immediately.
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { Pool } = require('pg');
const config = require('./env');
const { pgPoolOptions } = require('./database');
const logger = require('../utils/logger');
const { SESSION_COOKIE_NAME } = require('../constants/auth');
const { STUDENT_IDLE_MINUTES } = require('../constants/limits');

const pool = new Pool(pgPoolOptions(config.nodeEnv));

// Without this listener, a database restart would crash the whole process.
pool.on('error', (err) => {
  logger.error({ err }, 'Session store database connection error');
});

const PgStore = connectPgSimple(session);
const store = new PgStore({
  pool,
  tableName: 'sessions',
  createTableIfMissing: false, // the migrations own the table
  pruneSessionInterval: config.isTest ? false : 15 * 60, // delete expired rows every 15 min
  errorLog: (err) => logger.error({ err }, 'Session store error'),
});

// Attributes used when the cookie is set AND when it is cleared (they must match).
const cookieOptions = Object.freeze({
  httpOnly: true, // JavaScript on the page cannot read it (limits XSS damage)
  secure: config.cookieSecure, // HTTPS only (needs TRUST_PROXY behind a proxy)
  sameSite: config.cookieSameSite,
  path: '/',
});

const sessionMiddleware = session({
  name: SESSION_COOKIE_NAME,
  secret: config.sessionSecret,
  store,
  resave: false,
  saveUninitialized: false, // guests never get a cookie
  rolling: true,
  unset: 'destroy',
  cookie: { ...cookieOptions, maxAge: STUDENT_IDLE_MINUTES * 60 * 1000 },
});

// Called on shutdown (and by tests) so the process can exit cleanly.
async function closeSessionStore() {
  if (typeof store.close === 'function') store.close();
  await pool.end();
}

module.exports = { sessionMiddleware, cookieOptions, pool, store, closeSessionStore };
