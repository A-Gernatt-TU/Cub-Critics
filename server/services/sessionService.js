'use strict';
// Everything that creates, reads or ends a login session (FR#7, SC#5, SC#12, SC#13).
const { promisify } = require('node:util');
const { sequelize, User } = require('../models');
const { ROLE } = require('../constants/roles');
const { USER_STATUS } = require('../constants/statuses');
const { STUDENT_IDLE_MINUTES, ADMIN_IDLE_MINUTES } = require('../constants/limits');
const { SESSION_COOKIE_NAME } = require('../constants/auth');
const { cookieOptions } = require('../config/session');

// SC#12: students are logged out after 30 idle minutes, administrators after 15.
function idleTimeoutMs(role) {
  const minutes = role === ROLE.ADMINISTRATOR ? ADMIN_IDLE_MINUTES : STUDENT_IDLE_MINUTES;
  return minutes * 60 * 1000;
}

// `rolling` sessions reset the cookie to originalMaxAge on every response, so both
// values must be set for the role's timeout to stick.
function applyIdleTimeout(session, role) {
  const ms = idleTimeoutMs(role);
  session.cookie.maxAge = ms;
  session.cookie.originalMaxAge = ms;
}

// Logs the user in: a brand-new session id is issued (so an id that existed before
// login can never be reused: session fixation), then the session is saved.
async function startSession(req, user) {
  await promisify(req.session.regenerate.bind(req.session))();
  req.session.userId = user.id;
  applyIdleTimeout(req.session, user.role);
  await promisify(req.session.save.bind(req.session))();

  // Lets us delete every session of one user in a single query (SC#13).
  await sequelize.query('UPDATE sessions SET user_id = :userId WHERE sid = :sid', {
    replacements: { userId: user.id, sid: req.sessionID },
  });
}

// FR#7: ends the session immediately and removes it from the database.
async function endSession(req) {
  if (!req.session) return;
  await promisify(req.session.destroy.bind(req.session))();
}

// Returns the logged-in user, or null. The user is re-read from the database on every
// call, so a deactivated account or a changed role takes effect immediately (SC#3, SC#13).
async function getSessionUser(req, res) {
  const userId = req.session && req.session.userId;
  if (!userId) return null;

  const user = await User.findByPk(userId);
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    await endSession(req);
    if (res) res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
    return null;
  }

  applyIdleTimeout(req.session, user.role);
  return user;
}

// Logs a user out of every device (used when an account is deactivated).
async function destroyAllSessionsForUser(userId) {
  await sequelize.query('DELETE FROM sessions WHERE user_id = :userId', {
    replacements: { userId },
  });
}

module.exports = {
  idleTimeoutMs,
  applyIdleTimeout,
  startSession,
  endSession,
  getSessionUser,
  destroyAllSessionsForUser,
};
