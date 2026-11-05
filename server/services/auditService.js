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
  // Administrator changes (AL#2)
  VENUE_CREATED: 'venue_created',
  VENUE_UPDATED: 'venue_updated',
  VENUE_DEACTIVATED: 'venue_deactivated',
  VENUE_REACTIVATED: 'venue_reactivated',
  MENU_ITEM_CREATED: 'menu_item_created',
  MENU_ITEM_UPDATED: 'menu_item_updated',
  MENU_ITEM_DELETED: 'menu_item_deleted',
  PHOTO_ADDED: 'photo_added',
  PHOTO_REMOVED: 'photo_removed',
  CATEGORY_CREATED: 'category_created',
  CATEGORY_UPDATED: 'category_updated',
  CATEGORY_DELETED: 'category_deleted',
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

// For changes that must not happen without their audit entry (administrator changes, AL#2):
// written INSIDE the same database transaction, and any failure cancels the whole change.
async function recordInTransaction(
  { actorId, eventType, entityType, entityId, ip, details },
  transaction
) {
  await AuditLog.create(
    {
      actor_id: actorId ?? null,
      event_type: eventType,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      ip_address: cleanIp(ip),
      details: details ?? null,
    },
    { transaction }
  );
}

module.exports = { EVENTS, record, recordInTransaction };
