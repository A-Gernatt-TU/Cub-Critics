'use strict';
// Writes audit_log rows (AL#2, AL#3). Auditing is best-effort: if the write fails it is
// logged, but the person's request is not failed because of it.
const net = require('node:net');
const { AuditLog } = require('../models');
const logger = require('../utils/logger');

const EVENTS = Object.freeze({
  REGISTER: 'register',
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGIN_LOCKED: 'login_locked', // an attempt was refused because the account is locked
  ACCOUNT_LOCKED: 'account_locked', // the failed attempt that triggered the lock
  LOGOUT: 'logout',
});

// The column is type INET, so anything that is not a plain IP address is stored as NULL.
function cleanIp(ip) {
  if (typeof ip !== 'string') return null;
  const withoutZone = ip.split('%')[0];
  return net.isIP(withoutZone) ? withoutZone : null;
}

// Never put passwords, session ids or attempted emails in `details`.
async function record({ actorId, eventType, entityType, entityId, ip, details }) {
  try {
    await AuditLog.create({
      actor_id: actorId ?? null,
      event_type: eventType,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      ip_address: cleanIp(ip),
      details: details ?? null,
    });
  } catch (err) {
    logger.error({ err, eventType }, 'Failed to write audit log entry');
  }
}

module.exports = { EVENTS, record };
