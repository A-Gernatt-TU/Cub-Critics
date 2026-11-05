'use strict';
// Public venue pages: the directory with search/filter/sort, and a venue's detail page
// (FR#17-FR#23, FR#32-FR#39). Administrator changes live in venueAdminService.js.
//
// Safety: SQL here is assembled only from fixed text. Everything a visitor typed reaches
// the database as a bound parameter ($name), never pasted into the SQL (SC#4).
const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  Venue,
  Category,
  VenueHour,
  VenueSpecialHour,
  VenuePhoto,
  MenuItem,
} = require('../models');
const { VENUE_STATUS } = require('../constants/statuses');
const { MENU_NOTICE } = require('../constants/notices');
const { RATING_JOIN_SQL, ratingFromRow } = require('./ratingService');
const openStatus = require('./openStatusService');
const {
  serializeVenueSummary,
  serializeMenuItem,
  serializePhoto,
} = require('../utils/serializers');
const { NotFoundError } = require('../utils/httpExceptions');

const MAX_MATCHED_ITEMS = 3;
const SPECIAL_HOURS_WINDOW_DAYS = 60;

// A search term becomes a "contains" pattern. % _ and \ typed by the visitor are escaped so
// they mean themselves, not "anything".
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id;

// Highest rating first; venues nobody has rated yet come last; ties go to the venue with more
// reviews, then to the name.
const byRating = (a, b) =>
  (b.avgRating ?? -1) - (a.avgRating ?? -1) || b.reviewCount - a.reviewCount || byName(a, b);

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
}

async function loadSchedules(venueIds, now) {
  const today = openStatus.easternParts(now).date;
  const [weekly, special] = await Promise.all([
    VenueHour.findAll({ where: { venue_id: venueIds }, raw: true }),
    VenueSpecialHour.findAll({
      where: {
        venue_id: venueIds,
        date: {
          [Op.between]: [
            openStatus.addDays(today, -1),
            openStatus.addDays(today, openStatus.LOOKAHEAD_DAYS),
          ],
        },
      },
      raw: true,
    }),
  ]);
  return { weekly: groupBy(weekly, 'venue_id'), special: groupBy(special, 'venue_id') };
}

async function listCategories() {
  const categories = await Category.findAll({ order: [['name', 'ASC']], raw: true });
  return categories.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * The venue directory with search, filters and sorting, all applied together (FR#37).
 *   q          venue name OR menu item name, ignoring case and surrounding spaces (FR#32, FR#33)
 *   categoryIds, minRating, openNow (FR#34-FR#36)
 *   sort       'name' (A-Z, default) or 'rating' (highest first) (FR#38)
 *   limit      for "top rated" lists on the home page (FR#17)
 * `total` is the number of matching venues before `limit` (FR#37).
 */
async function listVenues(filters = {}, now = new Date()) {
  const { q, categoryIds, minRating, openNow, sort = 'name', limit } = filters;

  const conditions = ["v.status = 'active'"];
  const bind = {};
  if (categoryIds && categoryIds.length > 0) {
    conditions.push('v.category_id = ANY($categoryIds)');
    bind.categoryIds = categoryIds;
  }
  if (q) {
    bind.pattern = likePattern(q);
    conditions.push(
      "(v.name ILIKE $pattern ESCAPE '\\' OR EXISTS (SELECT 1 FROM menu_items m WHERE m.venue_id = v.id AND m.name ILIKE $pattern ESCAPE '\\'))"
    );
  }
  if (minRating > 0) {
    bind.minRating = minRating;
    conditions.push('r.avg_rating >= $minRating');
  }

  const sql = [
    'SELECT v.id, v.name, v.description, v.location, v.category_id, c.name AS category_name,',
    'r.avg_rating, r.review_count,',
    '(SELECT p.storage_key FROM venue_photos p WHERE p.venue_id = v.id ORDER BY p.sort_order, p.id LIMIT 1) AS thumbnail_key',
    'FROM venues v',
    'JOIN categories c ON c.id = v.category_id',
    RATING_JOIN_SQL,
    'WHERE',
    conditions.join(' AND '),
  ].join(' ');

  const rows = await sequelize.query(sql, { bind, type: QueryTypes.SELECT });
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { venues: [], total: 0 };

  const schedules = await loadSchedules(ids, now);
  let venues = rows.map((row) => ({
    row,
    rating: ratingFromRow(row),
    openStatus: openStatus.statusAt(
      schedules.weekly.get(row.id) || [],
      schedules.special.get(row.id) || [],
      now
    ),
  }));

  if (openNow) venues = venues.filter((venue) => venue.openStatus.isOpen);

  const compare = sort === 'rating' ? byRating : byName;
  venues = venues.map((v) => ({ ...v, name: v.row.name, id: v.row.id, ...v.rating })).sort(compare);
  const total = venues.length;
  if (limit) venues = venues.slice(0, limit);

  // For a search, say WHICH menu items matched, so a search for "wrap" shows the wrap.
  let matches = new Map();
  if (q && venues.length > 0) {
    const itemRows = await sequelize.query(
      "SELECT venue_id, name FROM menu_items WHERE venue_id = ANY($ids) AND name ILIKE $pattern ESCAPE '\\' ORDER BY name",
      { bind: { ids: venues.map((v) => v.id), pattern: bind.pattern }, type: QueryTypes.SELECT }
    );
    matches = groupBy(itemRows, 'venue_id');
  }

  return {
    venues: venues.map((v) =>
      serializeVenueSummary(v.row, {
        rating: v.rating,
        openStatus: v.openStatus,
        matchedMenuItems: q
          ? (matches.get(v.id) || []).slice(0, MAX_MATCHED_ITEMS).map((item) => item.name)
          : undefined,
      })
    ),
    total,
  };
}

/**
 * One venue's full page (FR#19, FR#20, FR#22): description, location, hours, photos, menu,
 * average rating and review count. Inactive venues are hidden (404) unless
 * `includeInactive` is set, which only administrator endpoints do.
 */
async function getVenueDetail(id, { includeInactive = false } = {}, now = new Date()) {
  const venue = await Venue.findOne({
    where: { id, ...(includeInactive ? {} : { status: VENUE_STATUS.ACTIVE }) },
    include: [{ model: Category, as: 'category' }],
  });
  if (!venue) throw new NotFoundError('Venue not found');

  const today = openStatus.easternParts(now).date;
  const [weekly, special, photos, items, ratingRows] = await Promise.all([
    VenueHour.findAll({ where: { venue_id: id }, raw: true }),
    VenueSpecialHour.findAll({
      where: {
        venue_id: id,
        // The public page shows the next 60 days. Administrators see EVERY upcoming date,
        // because saving the venue replaces the whole list: hiding far-off holidays from
        // the edit screen would delete them.
        date: includeInactive
          ? { [Op.gte]: openStatus.addDays(today, -1) }
          : {
              [Op.between]: [
                openStatus.addDays(today, -1),
                openStatus.addDays(today, SPECIAL_HOURS_WINDOW_DAYS),
              ],
            },
      },
      order: [
        ['date', 'ASC'],
        ['opens_at', 'ASC'],
      ],
      raw: true,
    }),
    VenuePhoto.findAll({
      where: { venue_id: id },
      order: [
        ['sort_order', 'ASC'],
        ['id', 'ASC'],
      ],
      raw: true,
    }),
    MenuItem.findAll({
      where: { venue_id: id },
      order: [
        ['name', 'ASC'],
        ['id', 'ASC'],
      ],
      raw: true,
    }),
    sequelize.query(
      [
        'SELECT r.avg_rating, r.review_count FROM venues v',
        RATING_JOIN_SQL,
        'WHERE v.id = $id',
      ].join(' '),
      {
        bind: { id },
        type: QueryTypes.SELECT,
      }
    ),
  ]);

  return {
    id: venue.id,
    name: venue.name,
    description: venue.description ?? null,
    location: venue.location ?? null,
    category: { id: venue.category.id, name: venue.category.name },
    ...(includeInactive ? { status: venue.status } : {}),
    ...ratingFromRow(ratingRows[0] || {}),
    openStatus: openStatus.statusAt(weekly, special, now),
    hours: openStatus.weeklySchedule(weekly),
    specialHours: openStatus.upcomingSpecialHours(special, now),
    // No photos is a normal state; the frontend shows its placeholder image (FR#22).
    photos: photos.map(serializePhoto),
    menu: { notice: MENU_NOTICE, items: items.map(serializeMenuItem) },
  };
}

module.exports = { listCategories, listVenues, getVenueDetail };
