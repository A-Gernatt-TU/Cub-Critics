'use strict';
// Request rules for venue endpoints. Admin schemas are added further down.
const { z } = require('zod');
const { safeText } = require('./common');
const {
  queryText,
  queryInteger,
  queryNumber,
  queryBoolean,
  queryEnum,
  queryIdList,
} = require('./common');

// GET /api/venues  (FR#32-FR#39)
const venueListQuerySchema = z.object({
  q: queryText('Search', { max: 100 }),
  category: queryIdList('Category'),
  minRating: queryNumber('Minimum rating', { min: 0, max: 5 }),
  openNow: queryBoolean('Open now'),
  sort: queryEnum('Sort', ['name', 'rating']),
  limit: queryInteger('Limit', { min: 1, max: 100 }),
});

// GET /api/venues/:id/reviews  (FR#30)
const reviewListQuerySchema = z.object({
  sort: queryEnum('Sort', ['newest', 'oldest', 'highest', 'lowest']),
  limit: queryInteger('Limit', { min: 1, max: 50 }),
  offset: queryInteger('Offset', { min: 0, max: 100000 }),
});

// ---------------------------------------------------------------------------
// Administrator: venues, hours, menu items, categories (FR#45-FR#50)
// ---------------------------------------------------------------------------
const MAX_ID = 2147483647;
const TIME_MESSAGE = 'Time must look like 07:30 (24-hour clock)';
const DAY_MESSAGE = 'Day must be a number from 0 (Sunday) to 6 (Saturday)';

const timeOfDay = z
  .string({ error: TIME_MESSAGE })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, TIME_MESSAGE);
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

const id = (label) =>
  z
    .number({ error: `${label} is required` })
    .int(`${label} is required`)
    .positive(`${label} is required`)
    .max(MAX_ID, `${label} is required`);

// One opening period, or "closed all day". Used for weekly hours and for holiday hours.
function periodFields(entry, ctx) {
  const hasTimes = entry.opensAt !== undefined || entry.closesAt !== undefined;
  if (entry.isClosed === true) {
    if (hasTimes)
      ctx.addIssue({
        code: 'custom',
        path: ['isClosed'],
        message: 'A closed day cannot have opening times',
      });
  } else {
    if (entry.opensAt === undefined)
      ctx.addIssue({ code: 'custom', path: ['opensAt'], message: 'Opening time is required' });
    if (entry.closesAt === undefined)
      ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'Closing time is required' });
  }
}

// True if one day lists a closed marker next to hours, or two periods overlap.
// A period whose closing time is not after its opening time runs past midnight; for the
// overlap check it counts until the end of its own day.
function hasConflicts(entries, keyOf) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  for (const list of byKey.values()) {
    if (list.some((e) => e.isClosed) && list.length > 1) return true;
    // Entries missing a time already carry their own error message; skip them here.
    const periods = list
      .filter((e) => !e.isClosed && e.opensAt !== undefined && e.closesAt !== undefined)
      .map((e) => {
        const start = minutesOf(e.opensAt);
        const close = minutesOf(e.closesAt);
        return { start, end: close > start ? close : 1440 };
      })
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < periods.length; i += 1) {
      if (periods[i].start < periods[i - 1].end) return true;
    }
  }
  return false;
}

const weeklyEntry = z
  .object({
    dayOfWeek: z
      .number({ error: DAY_MESSAGE })
      .int(DAY_MESSAGE)
      .min(0, DAY_MESSAGE)
      .max(6, DAY_MESSAGE),
    isClosed: z.boolean().optional(),
    opensAt: timeOfDay.optional(),
    closesAt: timeOfDay.optional(),
  })
  .superRefine(periodFields);

// [{ dayOfWeek: 1, opensAt: '07:00', closesAt: '20:00' }, { dayOfWeek: 0, isClosed: true }]
// A day with no entry is closed. Several periods per day are allowed (lunch and dinner).
const hoursSchema = z
  .array(weeklyEntry, { error: 'Hours must be a list' })
  .min(1, 'Please enter the operating hours')
  .max(50, 'Too many opening periods')
  .refine((entries) => !hasConflicts(entries, (e) => e.dayOfWeek), {
    error: 'A day cannot have overlapping periods, or be both closed and open',
  });

const DATE_MESSAGE = 'Date must look like 2026-11-26';
const calendarDate = z
  .string({ error: DATE_MESSAGE })
  .regex(/^\d{4}-\d{2}-\d{2}$/, DATE_MESSAGE)
  .refine((value) => {
    // 2026-02-30 is not a date: JavaScript makes it an invalid Date, and toISOString() on an
    // invalid Date throws (which would have been a server error instead of a clear message).
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, DATE_MESSAGE);

const specialEntry = z
  .object({
    date: calendarDate,
    isClosed: z.boolean().optional(),
    opensAt: timeOfDay.optional(),
    closesAt: timeOfDay.optional(),
    note: safeText('Note', { max: 100 }).nullish(),
  })
  .superRefine(periodFields);

// Holiday and one-off hours. They replace the weekly hours for that date only.
const specialHoursSchema = z
  .array(specialEntry, { error: 'Special hours must be a list' })
  .max(100, 'Too many special dates')
  .refine((entries) => !hasConflicts(entries, (e) => e.date), {
    error: 'A date cannot have overlapping periods, or be both closed and open',
  });

const venueText = {
  name: safeText('Name', { min: 1, max: 100 }),
  description: safeText('Description', { min: 1, max: 1000, multiline: true }),
  location: safeText('Location', { min: 1, max: 100 }),
  categoryId: id('Category'),
};

// POST /api/admin/venues  (FR#45)
const createVenueSchema = z.object({
  ...venueText,
  hours: hoursSchema,
  specialHours: specialHoursSchema.optional(),
});

// PATCH /api/admin/venues/:id  (FR#46). Send only what changes. `hours` and `specialHours`
// REPLACE the whole list when sent.
const updateVenueSchema = z
  .object({
    name: venueText.name.optional(),
    description: venueText.description.optional(),
    location: venueText.location.optional(),
    categoryId: venueText.categoryId.optional(),
    hours: hoursSchema.optional(),
    specialHours: specialHoursSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    error: 'Send at least one thing to change',
    path: ['name'],
  });

const price = z
  .number({ error: 'Price must be a number' })
  .min(0, 'Price cannot be negative')
  .max(9999.99, 'Price must be $9,999.99 or less')
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, {
    error: 'Price can have at most two decimal places',
  });

const menuItemFields = {
  name: safeText('Name', { min: 1, max: 100 }),
  description: safeText('Description', { max: 500, multiline: true })
    .nullish()
    .transform((text) => text || null),
  price,
};

// POST /api/admin/venues/:id/menu-items  (FR#48)
const createMenuItemSchema = z.object(menuItemFields);

// PATCH /api/admin/menu-items/:id  (FR#49)
const updateMenuItemSchema = z
  .object({
    name: menuItemFields.name.optional(),
    description: safeText('Description', { max: 500, multiline: true }).nullable().optional(),
    price: price.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    error: 'Send at least one thing to change',
    path: ['name'],
  });

// POST/PATCH /api/admin/categories
const categorySchema = z.object({ name: safeText('Name', { min: 1, max: 50 }) });

module.exports = {
  venueListQuerySchema,
  reviewListQuerySchema,
  createVenueSchema,
  updateVenueSchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  categorySchema,
};
