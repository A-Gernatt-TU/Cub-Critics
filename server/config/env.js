'use strict';
// Reads and validates environment variables in one place (SC#8). If anything is
// wrong the server refuses to start and lists every problem at once.
require('dotenv').config({ quiet: true });

const VALID_ENVS = ['development', 'test', 'production'];
const SAME_SITE_VALUES = ['lax', 'strict', 'none'];
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

function isOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null; // invalid
}

function loadConfig(env = process.env) {
  const problems = [];

  const nodeEnv = env.NODE_ENV || 'development';
  if (!VALID_ENVS.includes(nodeEnv)) {
    problems.push(`NODE_ENV must be one of ${VALID_ENVS.join(', ')} (got "${nodeEnv}")`);
  }
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const port = Number(env.SERVER_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('SERVER_PORT must be a whole number between 1 and 65535');
  }

  // Origins of the React app that may call this API from a browser.
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    if (!isOrigin(origin)) {
      problems.push(
        `ALLOWED_ORIGINS entry "${origin}" must look like http://localhost:5173 (no path, no trailing slash)`
      );
    }
  }

  // How many reverse proxies sit in front of the app (needed for correct client IPs and
  // for Secure cookies behind HTTPS-terminating hosts). Most hosts put exactly one in
  // front, so production defaults to 1.
  const trustProxy =
    env.TRUST_PROXY === undefined || env.TRUST_PROXY === ''
      ? isProduction
        ? 1
        : 0
      : Number(env.TRUST_PROXY);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    problems.push('TRUST_PROXY must be a whole number of 0 or more');
  }

  // ---- Sessions and cookies (SC#5) ----
  let sessionSecret = env.SESSION_SECRET || undefined;
  if (isTest && !sessionSecret) sessionSecret = 'test-only-session-secret';
  if (!sessionSecret) {
    problems.push('SESSION_SECRET is required (use a long random string; see .env.example)');
  } else if (isProduction && (sessionSecret.length < 32 || sessionSecret === 'change_me')) {
    problems.push('SESSION_SECRET must be a random string of at least 32 characters in production');
  }

  const cookieSecure = parseBoolean(env.COOKIE_SECURE, isProduction);
  if (cookieSecure === null) problems.push('COOKIE_SECURE must be true or false');

  const cookieSameSite = (env.COOKIE_SAMESITE || 'lax').toLowerCase();
  if (!SAME_SITE_VALUES.includes(cookieSameSite)) {
    problems.push(`COOKIE_SAMESITE must be one of ${SAME_SITE_VALUES.join(', ')}`);
  }
  if (cookieSameSite === 'none' && cookieSecure === false) {
    problems.push(
      'COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browsers reject it otherwise)'
    );
  }
  if (isProduction && cookieSecure === false) {
    problems.push('COOKIE_SECURE must not be false in production (SC#1, SC#5)');
  }

  // ---- Accounts ----
  // bcrypt cost. 12 is a good default; tests use the minimum to stay fast.
  const bcryptRounds = Number(env.BCRYPT_ROUNDS || (isTest ? 4 : 12));
  if (!Number.isInteger(bcryptRounds) || bcryptRounds < 4 || bcryptRounds > 15) {
    problems.push('BCRYPT_ROUNDS must be a whole number from 4 to 15');
  }

  // TBD-1: limit registration to certain email domains. Empty = any email address.
  // Example: ALLOWED_EMAIL_DOMAINS=towson.edu (also accepts subdomains like students.towson.edu)
  const allowedEmailDomains = (env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const domain of allowedEmailDomains) {
    if (!DOMAIN_PATTERN.test(domain)) {
      problems.push(`ALLOWED_EMAIL_DOMAINS entry "${domain}" must look like towson.edu`);
    }
  }

  // Recorded on each account when the student accepts the Terms of Service (FR#2, FR#53).
  // Change it whenever the sponsor approves new text (TBD-5).
  const tosVersion = env.TOS_VERSION || 'draft-1';

  // The database settings themselves are read by config/database.js.
  const hasDatabase = Boolean(env.DATABASE_URL) || Boolean(env.DB_NAME && env.DB_USER);
  if (!isTest && !hasDatabase) {
    problems.push(
      'Database is not configured: set DATABASE_URL, or DB_NAME and DB_USER (plus DB_PASSWORD, DB_HOST, DB_PORT)'
    );
  }

  const logLevel = env.LOG_LEVEL || (isTest ? 'silent' : isProduction ? 'info' : 'debug');

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    port,
    allowedOrigins,
    trustProxy,
    sessionSecret,
    cookieSecure,
    cookieSameSite,
    bcryptRounds,
    allowedEmailDomains,
    tosVersion,
    logLevel,
  };
}

const config = loadConfig();

module.exports = Object.freeze({ ...config, loadConfig });
