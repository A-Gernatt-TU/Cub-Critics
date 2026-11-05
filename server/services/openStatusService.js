'use strict';
// Is a venue open right now? (FR#21). Always judged in US Eastern time, whatever the
// server's own clock or time zone is.
//
// Hours are stored per weekday (0 = Sunday ... 6 = Saturday) in venue_hours, and can be
// replaced for one specific date by venue_special_hours (holidays). Rules:
//  - A date that has special-hours rows uses ONLY those rows; the weekly hours are ignored.
//  - A period whose closing time is not after its opening time runs past midnight into the
//    next day (18:00-02:00). Identical times (00:00-00:00) mean open all day.
//  - A day with no usable period is closed.
//  - Several periods per day are fine (lunch and dinner).
const TIME_ZONE = 'America/New_York';
const MINUTES_PER_DAY = 24 * 60;
const LOOKAHEAD_DAYS = 7;

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// The date and time of day in Eastern time for an instant.
function easternParts(instant = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    dayOfWeek: dayOfWeekOf(date),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function dayOfWeekOf(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// '07:00:00' or '07:00' -> minutes after midnight
function toMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

// minutes after midnight (may exceed 24h for overnight) -> 'HH:MM'
function toClock(minutes) {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

// The open periods that START on a date, as { start, end } in minutes after that date's
// midnight. `end` is above 1440 for periods that run past midnight.
function periodsStartingOn(date, weeklyHours, specialHours) {
  const special = specialHours.filter((row) => row.date === date);
  const rows =
    special.length > 0
      ? special
      : weeklyHours.filter((row) => row.day_of_week === dayOfWeekOf(date));

  return rows
    .filter((row) => !row.is_closed && row.opens_at && row.closes_at)
    .map((row) => {
      const start = toMinutes(row.opens_at);
      const close = toMinutes(row.closes_at);
      return { start, end: close > start ? close : close + MINUTES_PER_DAY };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * statusAt(weeklyHours, specialHours, instant) ->
 *   { isOpen, closesAt: 'HH:MM' | null, nextOpen: { dayOfWeek, time, isToday } | null }
 * `weeklyHours` / `specialHours` are rows as stored in the database (snake_case columns).
 */
function statusAt(weeklyHours, specialHours, instant = new Date()) {
  const now = easternParts(instant);

  // Open now through a period that started today...
  const today = periodsStartingOn(now.date, weeklyHours, specialHours);
  const current = today.find((p) => p.start <= now.minutes && now.minutes < p.end);
  if (current) return { isOpen: true, closesAt: toClock(current.end), nextOpen: null };

  // ...or through one that started yesterday and runs past midnight.
  const yesterday = periodsStartingOn(addDays(now.date, -1), weeklyHours, specialHours);
  const carried = yesterday.find(
    (p) => p.end > MINUTES_PER_DAY && now.minutes < p.end - MINUTES_PER_DAY
  );
  if (carried) return { isOpen: true, closesAt: toClock(carried.end), nextOpen: null };

  // Closed: find the next time it opens.
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const date = addDays(now.date, offset);
    const upcoming = periodsStartingOn(date, weeklyHours, specialHours).find(
      (p) => offset > 0 || p.start > now.minutes
    );
    if (upcoming) {
      return {
        isOpen: false,
        closesAt: null,
        nextOpen: {
          dayOfWeek: dayOfWeekOf(date),
          time: toClock(upcoming.start),
          isToday: offset === 0,
        },
      };
    }
  }
  return { isOpen: false, closesAt: null, nextOpen: null };
}

// Seven entries (Sunday first) for display: { dayOfWeek, isClosed, periods: [{ opensAt, closesAt }] }
function weeklySchedule(weeklyHours) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const periods = weeklyHours
      .filter(
        (row) => row.day_of_week === dayOfWeek && !row.is_closed && row.opens_at && row.closes_at
      )
      .map((row) => ({
        opensAt: toClock(toMinutes(row.opens_at)),
        closesAt: toClock(toMinutes(row.closes_at)),
      }))
      .sort((a, b) => a.opensAt.localeCompare(b.opensAt));
    return { dayOfWeek, isClosed: periods.length === 0, periods };
  });
}

// Holiday/one-off hours still to come, for display.
function upcomingSpecialHours(specialHours, instant = new Date()) {
  const today = easternParts(instant).date;
  const byDate = new Map();
  for (const row of specialHours) {
    if (row.date < today) continue;
    if (!byDate.has(row.date))
      byDate.set(row.date, { date: row.date, note: row.note || null, isClosed: true, periods: [] });
    const entry = byDate.get(row.date);
    if (row.note && !entry.note) entry.note = row.note;
    if (!row.is_closed && row.opens_at && row.closes_at) {
      entry.isClosed = false;
      entry.periods.push({
        opensAt: toClock(toMinutes(row.opens_at)),
        closesAt: toClock(toMinutes(row.closes_at)),
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = {
  TIME_ZONE,
  LOOKAHEAD_DAYS,
  easternParts,
  addDays,
  toClock,
  statusAt,
  weeklySchedule,
  upcomingSpecialHours,
};
