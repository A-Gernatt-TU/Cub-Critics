'use strict';
// Register, login, logout, current user (FR#1-FR#7).
// Controllers return plain objects; utils/handler.js turns them into responses.
const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const { serializeOwnUser } = require('../utils/serializers');
const { cookieOptions } = require('../config/session');
const { SESSION_COOKIE_NAME } = require('../constants/auth');

// FR#1: creates a student account and signs the new student in.
async function register({ body, ip }, req) {
  const user = await authService.register({ ...body, ip });
  await sessionService.startSession(req, user);
  return { statusCode: 201, data: { user: serializeOwnUser(user) } };
}

// FR#4-FR#6
async function login({ body, ip }, req) {
  const user = await authService.login({ ...body, ip });
  await sessionService.startSession(req, user);
  return { data: { user: serializeOwnUser(user) } };
}

// FR#7: always succeeds, even when nobody is logged in.
async function logout({ ip }, req) {
  const userId = req.session && req.session.userId;
  if (userId) await authService.recordLogout({ userId, ip });
  await sessionService.endSession(req);
  return { clearCookies: [{ name: SESSION_COOKIE_NAME, options: cookieOptions }] };
}

// Lets the frontend find out who is logged in when the page loads. Guests are normal
// visitors (FR#9), so this answers { user: null } for them instead of an error.
async function me(_input, req) {
  const user = await sessionService.getSessionUser(req, req.res);
  return { data: { user: user ? serializeOwnUser(user) : null } };
}

module.exports = { register, login, logout, me };
