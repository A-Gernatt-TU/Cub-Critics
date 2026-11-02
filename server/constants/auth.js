'use strict';
// Rules for accounts and sessions.

// Letters, numbers and underscores, 3-30 characters. (The SRS leaves the format open.)
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

// People see usernames on reviews (SF#4), so names that look official are blocked.
const RESERVED_USERNAMES = Object.freeze([
  'admin',
  'administrator',
  'moderator',
  'mod',
  'staff',
  'support',
  'system',
  'cubcritics',
  'cub_critics',
  'towson',
  'anonymous',
]);

// bcrypt only uses the first 72 bytes of a password, so longer ones are refused.
const PASSWORD_MAX_BYTES = 72;

const SESSION_COOKIE_NAME = 'cubcritics.sid';

module.exports = {
  USERNAME_MIN,
  USERNAME_MAX,
  USERNAME_PATTERN,
  RESERVED_USERNAMES,
  PASSWORD_MAX_BYTES,
  SESSION_COOKIE_NAME,
};
