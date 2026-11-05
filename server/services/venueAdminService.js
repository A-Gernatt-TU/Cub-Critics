'use strict';
// Administrators manage venues (FR#45, FR#46, FR#47, AL#2). Each change and its audit entry
// are saved in one transaction. Hours are replaced as a whole inside that transaction, so a
// venue is never seen with half of its old hours and half of its new ones.
const { QueryTypes } = require('sequelize');
const { sequelize, Venue, Category, VenueHour, VenueSpecialHour } = require('../models');
const { VENUE_STATUS } = require('../constants/statuses');
const { RATING_JOIN_SQL, ratingFromRow } = require('./ratingService');
const venueService = require('./venueService');
const audit = require('./auditService');
const { NotFoundError, ValidationError } = require('../utils/httpExceptions');

const weeklyRows = (venueId, entries) =>
  entries.map((e) => ({
    venue_id: venueId,
    day_of_week: e.dayOfWeek,
    is_closed: e.isClosed === true,
    opens_at: e.isClosed === true ? null : e.opensAt,
    closes_at: e.isClosed === true ? null : e.closesAt,
  }));

const specialRows = (venueId, entries) =>
  entries.map((e) => ({
    venue_id: venueId,
    date: e.date,
    is_closed: e.isClosed === true,
    opens_at: e.isClosed === true ? null : e.opensAt,
    closes_at: e.isClosed === true ? null : e.closesAt,
    note: e.note || null,
  }));

async function requireCategory(categoryId, transaction) {
  if (!(await Category.findByPk(categoryId, { attributes: ['id'], transaction }))) {
    throw new ValidationError(undefined, [
      { field: 'categoryId', message: 'That category does not exist' },
    ]);
  }
}

// Every venue including deactivated ones, for the management screen.
async function listVenues() {
  const rows = await sequelize.query(
    [
      'SELECT v.id, v.name, v.status, v.location, v.category_id, c.name AS category_name,',
      'r.avg_rating, r.review_count,',
      '(SELECT COUNT(*)::int FROM menu_items m WHERE m.venue_id = v.id) AS menu_item_count,',
      '(SELECT COUNT(*)::int FROM venue_photos p WHERE p.venue_id = v.id) AS photo_count,',
      '(SELECT COUNT(*)::int FROM venue_hours h WHERE h.venue_id = v.id) AS hours_count',
      'FROM venues v JOIN categories c ON c.id = v.category_id',
      RATING_JOIN_SQL,
      'ORDER BY lower(v.name), v.id',
    ].join(' '),
    { type: QueryTypes.SELECT }
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    location: row.location ?? null,
    category: { id: row.category_id, name: row.category_name },
    ...ratingFromRow(row),
    menuItemCount: row.menu_item_count,
    photoCount: row.photo_count,
    hasHours: row.hours_count > 0,
  }));
}

// FR#45
async function createVenue(adminId, data, ip) {
  const venueId = await sequelize.transaction(async (transaction) => {
    await requireCategory(data.categoryId, transaction);
    const venue = await Venue.create(
      {
        name: data.name,
        category_id: data.categoryId,
        description: data.description,
        location: data.location,
      },
      { transaction }
    );
    await VenueHour.bulkCreate(weeklyRows(venue.id, data.hours), { transaction });
    if (data.specialHours && data.specialHours.length > 0) {
      await VenueSpecialHour.bulkCreate(specialRows(venue.id, data.specialHours), { transaction });
    }
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.VENUE_CREATED,
        entityType: 'venue',
        entityId: venue.id,
        ip,
        details: { name: venue.name },
      },
      transaction
    );
    return venue.id;
  });
  return venueService.getVenueDetail(venueId, { includeInactive: true });
}

// FR#46: only the parts that were sent change. Sending `hours` or `specialHours` replaces
// that whole list.
async function updateVenue(adminId, id, data, ip) {
  await sequelize.transaction(async (transaction) => {
    const venue = await Venue.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!venue) throw new NotFoundError('Venue not found');

    const next = {};
    if (data.name !== undefined) next.name = data.name;
    if (data.description !== undefined) next.description = data.description;
    if (data.location !== undefined) next.location = data.location;
    if (data.categoryId !== undefined) {
      await requireCategory(data.categoryId, transaction);
      next.category_id = data.categoryId;
    }
    if (Object.keys(next).length > 0) await venue.update(next, { transaction });

    if (data.hours !== undefined) {
      await VenueHour.destroy({ where: { venue_id: id }, transaction });
      await VenueHour.bulkCreate(weeklyRows(id, data.hours), { transaction });
    }
    if (data.specialHours !== undefined) {
      await VenueSpecialHour.destroy({ where: { venue_id: id }, transaction });
      if (data.specialHours.length > 0) {
        await VenueSpecialHour.bulkCreate(specialRows(id, data.specialHours), { transaction });
      }
    }
    // Touch updated_at even when only hours changed.
    await venue.update({ updated_at: new Date() }, { transaction });

    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.VENUE_UPDATED,
        entityType: 'venue',
        entityId: id,
        ip,
        details: { changed: Object.keys(data) },
      },
      transaction
    );
  });
  return venueService.getVenueDetail(id, { includeInactive: true });
}

// FR#47: deactivating hides the venue from the directory and search but keeps its reviews;
// reactivating brings it back. Asking for the state it is already in changes nothing.
async function setVenueStatus(adminId, id, status, ip) {
  await sequelize.transaction(async (transaction) => {
    const venue = await Venue.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!venue) throw new NotFoundError('Venue not found');
    if (venue.status === status) return;

    await venue.update({ status }, { transaction });
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType:
          status === VENUE_STATUS.INACTIVE
            ? audit.EVENTS.VENUE_DEACTIVATED
            : audit.EVENTS.VENUE_REACTIVATED,
        entityType: 'venue',
        entityId: id,
        ip,
        details: { name: venue.name },
      },
      transaction
    );
  });
  return venueService.getVenueDetail(id, { includeInactive: true });
}

module.exports = { listVenues, createVenue, updateVenue, setVenueStatus };
