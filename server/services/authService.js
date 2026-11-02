'use strict';
// Registration and login rules (FR#1-FR#7, FR#53, SC#2).
const bcrypt = require('bcrypt');
const { UniqueConstraintError, fn, col, where } = require('sequelize');
const config = require('../config/env');
const { sequelize, User } = require('../models');
const { ROLE } = require('../constants/roles');
const { USER_STATUS } = require('../constants/statuses');
const { LOGIN_MAX_FAILURES, LOGIN_LOCK_MINUTES } = require('../constants/limits');
const { PASSWORD_MAX_BYTES } = require('../constants/auth');
const audit = require('./auditService');
const {
  UnauthorizedError,
  TooManyRequestsError,
  ValidationError,
  ConflictError,
} = require('../utils/httpExceptions');

const lowerEq = (column, value) => where(fn('lower', col(column)), value.toLowerCase());

async function isEmailTaken(email) {
  return Boolean(await User.findOne({ attributes: ['id'], where: lowerEq('email', email) }));
}

async function isUsernameTaken(username) {
  return Boolean(await User.findOne({ attributes: ['id'], where: lowerEq('username', username) }));
}

// FR#1-FR#3. `email`, `username`, `password` have already been validated and cleaned.
// A new account is ALWAYS a student, whatever the request says (administrators are
// created directly in the database: A#6, SC#14).
async function register({ email, username, password, ip }) {
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

  let user;
  try {
    user = await User.create({
      email,
      username,
      password_hash: passwordHash,
      role: ROLE.STUDENT,
      tos_version: config.tosVersion,
      tos_accepted_at: new Date(),
    });
  } catch (err) {
    // Two people registering the same email/username at the same moment both pass the
    // earlier check; the database's unique indexes stop the second one.
    if (err instanceof UniqueConstraintError) throw await duplicateError(email, username);
    throw err;
  }

  await audit.record({
    actorId: user.id,
    eventType: audit.EVENTS.REGISTER,
    entityType: 'user',
    entityId: user.id,
    ip,
  });
  return user;
}

async function duplicateError(email, username) {
  const details = [];
  if (await isEmailTaken(email)) {
    details.push({ field: 'email', message: 'That email address is already registered' });
  }
  if (await isUsernameTaken(username)) {
    details.push({ field: 'username', message: 'That username is already taken' });
  }
  return details.length > 0
    ? new ValidationError(undefined, details)
    : new ConflictError('That account could not be created');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

const invalidCredentials = () =>
  new UnauthorizedError('Invalid email or password', { code: 'INVALID_CREDENTIALS' });

function lockedError(lockedUntil) {
  const seconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return new TooManyRequestsError(
    `Too many failed login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { code: 'ACCOUNT_LOCKED', retryAfterSeconds: seconds }
  );
}

// bcrypt silently ignores everything after 72 bytes, so a longer password can never be
// a real one (registration refuses them) and is simply treated as wrong.
async function passwordMatches(password, hash) {
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return false;
  return bcrypt.compare(password, hash);
}

// Unknown emails still do one bcrypt comparison, so response time does not reveal
// whether an account exists (FR#5).
let dummyHashPromise;
async function burnPasswordCheck(password) {
  dummyHashPromise ||= bcrypt.hash('not-a-real-password', config.bcryptRounds);
  await passwordMatches(password, await dummyHashPromise);
}

// FR#6: 5 consecutive failed attempts block the account for 15 minutes.
//
// The attempt is COUNTED BEFORE the password is checked, inside a short transaction that
// locks the account's row. That means parallel requests cannot all slip in before the
// first failure is recorded: the 6th and later attempts are refused without ever being
// checked, even if they arrive in the same millisecond. A correct password resets the
// counter afterwards.
async function reserveLoginAttempt(userId) {
  return sequelize.transaction(async (transaction) => {
    const row = await User.findByPk(userId, {
      attributes: ['id', 'failed_login_count', 'locked_until'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) return { missing: true };

    const now = new Date();
    if (row.locked_until && row.locked_until > now) {
      return { blocked: true, lockedUntil: row.locked_until };
    }

    // A lock that has run out starts a fresh count.
    const count = (row.locked_until ? 0 : row.failed_login_count) + 1;
    const lockedUntil =
      count >= LOGIN_MAX_FAILURES ? new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000) : null;

    await row.update({ failed_login_count: count, locked_until: lockedUntil }, { transaction });
    return { blocked: false, lockedUntil };
  });
}

async function login({ email, password, ip }) {
  const user = await User.scope('withPassword').findOne({ where: lowerEq('email', email) });

  // Unknown email or deactivated account: same answer as a wrong password (FR#5).
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    await burnPasswordCheck(password);
    await audit.record({
      actorId: user ? user.id : null,
      eventType: audit.EVENTS.LOGIN_FAILED,
      ip,
      details: { reason: user ? 'inactive_account' : 'unknown_account' },
    });
    throw invalidCredentials();
  }

  const attempt = await reserveLoginAttempt(user.id);
  if (attempt.missing) throw invalidCredentials();

  if (attempt.blocked) {
    await audit.record({
      actorId: user.id,
      eventType: audit.EVENTS.LOGIN_LOCKED,
      ip,
      details: { reason: 'account_locked' },
    });
    throw lockedError(attempt.lockedUntil);
  }

  if (!(await passwordMatches(password, user.password_hash))) {
    await audit.record({
      actorId: user.id,
      eventType: attempt.lockedUntil ? audit.EVENTS.ACCOUNT_LOCKED : audit.EVENTS.LOGIN_FAILED,
      ip,
      details: { reason: 'wrong_password' },
    });
    // The failed attempt that reached the limit tells the person right away.
    if (attempt.lockedUntil) throw lockedError(attempt.lockedUntil);
    throw invalidCredentials();
  }

  await User.update({ failed_login_count: 0, locked_until: null }, { where: { id: user.id } });
  await audit.record({
    actorId: user.id,
    eventType: audit.EVENTS.LOGIN_SUCCESS,
    ip,
  });
  return user;
}

async function recordLogout({ userId, ip }) {
  await audit.record({ actorId: userId, eventType: audit.EVENTS.LOGOUT, ip });
}

module.exports = { isEmailTaken, isUsernameTaken, register, login, recordLogout };
