'use strict';
// Administrators manage menu items (FR#48, FR#49, FR#50, AL#2).
const { sequelize, Venue, MenuItem } = require('../models');
const audit = require('./auditService');
const { MENU_MAX_ITEMS_PER_VENUE } = require('../constants/limits');
const { serializeMenuItem } = require('../utils/serializers');
const { NotFoundError, ConflictError } = require('../utils/httpExceptions');

async function createMenuItem(adminId, venueId, { name, description, price }, ip) {
  return sequelize.transaction(async (transaction) => {
    // Locking the venue makes the "too many items" check reliable when two requests overlap.
    const venue = await Venue.findByPk(venueId, {
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!venue) throw new NotFoundError('Venue not found');

    if (
      (await MenuItem.count({ where: { venue_id: venueId }, transaction })) >=
      MENU_MAX_ITEMS_PER_VENUE
    ) {
      throw new ConflictError(`A venue can have at most ${MENU_MAX_ITEMS_PER_VENUE} menu items`, {
        code: 'MENU_FULL',
      });
    }
    const item = await MenuItem.create(
      { venue_id: venueId, name, description, price },
      { transaction }
    );
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.MENU_ITEM_CREATED,
        entityType: 'menu_item',
        entityId: item.id,
        ip,
        details: { venueId, name },
      },
      transaction
    );
    return serializeMenuItem(item);
  });
}

async function updateMenuItem(adminId, itemId, changes, ip) {
  return sequelize.transaction(async (transaction) => {
    const item = await MenuItem.findByPk(itemId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw new NotFoundError('Menu item not found');

    const next = {};
    if (changes.name !== undefined) next.name = changes.name;
    if (changes.description !== undefined) next.description = changes.description || null;
    if (changes.price !== undefined) next.price = changes.price;
    await item.update(next, { transaction });

    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.MENU_ITEM_UPDATED,
        entityType: 'menu_item',
        entityId: itemId,
        ip,
        details: { venueId: item.venue_id, changed: Object.keys(next) },
      },
      transaction
    );
    await item.reload({ transaction });
    return serializeMenuItem(item);
  });
}

async function deleteMenuItem(adminId, itemId, ip) {
  await sequelize.transaction(async (transaction) => {
    const item = await MenuItem.findByPk(itemId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw new NotFoundError('Menu item not found');
    await item.destroy({ transaction });
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.MENU_ITEM_DELETED,
        entityType: 'menu_item',
        entityId: itemId,
        ip,
        details: { venueId: item.venue_id, name: item.name },
      },
      transaction
    );
  });
}

module.exports = { createMenuItem, updateMenuItem, deleteMenuItem };
