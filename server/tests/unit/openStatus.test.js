// FR#21: open/closed is judged in US Eastern time. Every test pins an exact instant.
// Reference: Monday 2 November 2026. Daylight saving ended on Sunday 1 November, so Eastern
// time is UTC-5 (EST) from then on, and UTC-4 (EDT) before it.
const {
  easternParts,
  addDays,
  toClock,
  statusAt,
  weeklySchedule,
  upcomingSpecialHours,
} = require('../../services/openStatusService');

const EST = (iso) => new Date(`${iso}-05:00`); // e.g. EST('2026-11-02T12:00:00')
const EDT = (iso) => new Date(`${iso}-04:00`);

const row = (day_of_week, opens_at, closes_at, extra = {}) => ({
  day_of_week,
  opens_at,
  closes_at,
  is_closed: false,
  ...extra,
});
const closedDay = (day_of_week) => ({
  day_of_week,
  opens_at: null,
  closes_at: null,
  is_closed: true,
});
const special = (date, opens_at, closes_at, extra = {}) => ({
  date,
  opens_at,
  closes_at,
  is_closed: false,
  ...extra,
});
const specialClosed = (date, note = null) => ({
  date,
  opens_at: null,
  closes_at: null,
  is_closed: true,
  note,
});

// Monday-Friday 07:00-20:00, closed weekends (the way the database returns TIME: HH:MM:SS)
const weekdays = [1, 2, 3, 4, 5].map((d) => row(d, '07:00:00', '20:00:00'));

describe('easternParts', () => {
  test('converts an instant to the Eastern date, weekday and minutes', () => {
    expect(easternParts(new Date('2026-11-02T17:00:00Z'))).toEqual({
      date: '2026-11-02',
      dayOfWeek: 1,
      minutes: 720,
    });
  });

  test('uses Eastern, not UTC: late evening Eastern is already "tomorrow" in UTC', () => {
    expect(easternParts(new Date('2026-11-03T03:30:00Z'))).toEqual({
      date: '2026-11-02',
      dayOfWeek: 1,
      minutes: 22 * 60 + 30,
    });
  });

  test('handles midnight exactly, without a "24:00" glitch', () => {
    expect(easternParts(new Date('2026-11-02T05:00:00Z'))).toEqual({
      date: '2026-11-02',
      dayOfWeek: 1,
      minutes: 0,
    });
    expect(easternParts(new Date('2026-11-02T04:59:00Z'))).toEqual({
      date: '2026-11-01',
      dayOfWeek: 0,
      minutes: 23 * 60 + 59,
    });
  });

  test('follows daylight saving: the same UTC time is one hour different in summer', () => {
    expect(easternParts(new Date('2026-07-01T16:00:00Z')).minutes).toBe(12 * 60); // EDT
    expect(easternParts(new Date('2026-12-01T16:00:00Z')).minutes).toBe(11 * 60); // EST
  });

  test('addDays crosses month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('toClock wraps past midnight', () => {
    expect(toClock(7 * 60)).toBe('07:00');
    expect(toClock(26 * 60)).toBe('02:00');
  });
});

describe('statusAt: ordinary hours', () => {
  test('open during the day, and says when it closes', () => {
    expect(statusAt(weekdays, [], EST('2026-11-02T12:00:00'))).toEqual({
      isOpen: true,
      closesAt: '20:00',
      nextOpen: null,
    });
  });

  test('opens exactly at the opening time, closes exactly at the closing time', () => {
    expect(statusAt(weekdays, [], EST('2026-11-02T07:00:00')).isOpen).toBe(true);
    expect(statusAt(weekdays, [], EST('2026-11-02T06:59:00')).isOpen).toBe(false);
    expect(statusAt(weekdays, [], EST('2026-11-02T19:59:00')).isOpen).toBe(true);
    expect(statusAt(weekdays, [], EST('2026-11-02T20:00:00')).isOpen).toBe(false);
  });

  test('before opening: says it opens later today', () => {
    expect(statusAt(weekdays, [], EST('2026-11-02T06:00:00'))).toEqual({
      isOpen: false,
      closesAt: null,
      nextOpen: { dayOfWeek: 1, time: '07:00', isToday: true },
    });
  });

  test('after closing on a Friday: next opening is Monday', () => {
    expect(statusAt(weekdays, [], EST('2026-11-06T21:00:00')).nextOpen).toEqual({
      dayOfWeek: 1,
      time: '07:00',
      isToday: false,
    });
  });

  test('on a closed weekend day', () => {
    expect(statusAt(weekdays, [], EST('2026-11-07T12:00:00'))).toMatchObject({ isOpen: false });
    expect(statusAt(weekdays, [], EST('2026-11-07T12:00:00')).nextOpen).toEqual({
      dayOfWeek: 1,
      time: '07:00',
      isToday: false,
    });
  });

  test('explicit "closed" rows behave like missing days', () => {
    const hours = [...weekdays, closedDay(0), closedDay(6)];
    expect(statusAt(hours, [], EST('2026-11-08T12:00:00')).isOpen).toBe(false);
  });

  test('no hours at all: closed, and no next opening', () => {
    expect(statusAt([], [], EST('2026-11-02T12:00:00'))).toEqual({
      isOpen: false,
      closesAt: null,
      nextOpen: null,
    });
  });

  test('rows with missing times are ignored rather than crashing', () => {
    expect(statusAt([row(1, null, null)], [], EST('2026-11-02T12:00:00')).isOpen).toBe(false);
  });

  test('uses Eastern time whatever time zone the caller is in', () => {
    // 12:00 Eastern is 17:00 UTC: open. 12:00 UTC is 07:00 Eastern: also open (opens at 07:00).
    expect(statusAt(weekdays, [], new Date('2026-11-02T17:00:00Z')).isOpen).toBe(true);
    expect(statusAt(weekdays, [], new Date('2026-11-02T11:59:00Z')).isOpen).toBe(false); // 06:59 Eastern
  });

  test('daylight saving: 07:00 local is 07:00 local before and after the change', () => {
    expect(statusAt(weekdays, [], EDT('2026-10-30T07:00:00')).isOpen).toBe(true);
    expect(statusAt(weekdays, [], EDT('2026-10-30T06:59:00')).isOpen).toBe(false);
    expect(statusAt(weekdays, [], EST('2026-11-02T07:00:00')).isOpen).toBe(true);
  });
});

describe('statusAt: split hours, overnight and all-day', () => {
  const lunchAndDinner = [row(1, '11:00:00', '14:00:00'), row(1, '17:00:00', '20:00:00')];

  test('between lunch and dinner it is closed, and opens again at 17:00', () => {
    expect(statusAt(lunchAndDinner, [], EST('2026-11-02T12:00:00'))).toMatchObject({
      isOpen: true,
      closesAt: '14:00',
    });
    expect(statusAt(lunchAndDinner, [], EST('2026-11-02T15:00:00'))).toMatchObject({
      isOpen: false,
      nextOpen: { dayOfWeek: 1, time: '17:00', isToday: true },
    });
    expect(statusAt(lunchAndDinner, [], EST('2026-11-02T18:00:00')).isOpen).toBe(true);
  });

  // Friday and Saturday 18:00 until 02:00 the next morning
  const lateNight = [row(5, '18:00:00', '02:00:00'), row(6, '18:00:00', '02:00:00')];

  test('open late on the night it starts', () => {
    expect(statusAt(lateNight, [], EST('2026-11-06T23:00:00'))).toEqual({
      isOpen: true,
      closesAt: '02:00',
      nextOpen: null,
    });
  });

  test('still open after midnight, because the Friday period runs into Saturday', () => {
    expect(statusAt(lateNight, [], EST('2026-11-07T01:30:00'))).toEqual({
      isOpen: true,
      closesAt: '02:00',
      nextOpen: null,
    });
  });

  test('closes at 02:00 sharp', () => {
    expect(statusAt(lateNight, [], EST('2026-11-07T01:59:00')).isOpen).toBe(true);
    expect(statusAt(lateNight, [], EST('2026-11-07T02:00:00')).isOpen).toBe(false);
  });

  test('Saturday evening opens again; Saturday night runs into Sunday morning', () => {
    expect(statusAt(lateNight, [], EST('2026-11-07T17:59:00')).isOpen).toBe(false);
    expect(statusAt(lateNight, [], EST('2026-11-07T18:00:00')).isOpen).toBe(true);
    expect(statusAt(lateNight, [], EST('2026-11-08T01:00:00')).isOpen).toBe(true);
    expect(statusAt(lateNight, [], EST('2026-11-08T02:00:00')).isOpen).toBe(false);
  });

  test('Thursday night (no hours) does NOT run into Friday morning', () => {
    expect(statusAt(lateNight, [], EST('2026-11-06T01:00:00')).isOpen).toBe(false);
  });

  test('identical opening and closing times mean open all day, and end at midnight', () => {
    const allDay = [row(1, '00:00:00', '00:00:00')];
    expect(statusAt(allDay, [], EST('2026-11-02T00:00:00')).isOpen).toBe(true);
    expect(statusAt(allDay, [], EST('2026-11-02T23:59:00')).isOpen).toBe(true);
    expect(statusAt(allDay, [], EST('2026-11-03T00:00:00')).isOpen).toBe(false);
  });
});

describe('statusAt: special (holiday) hours', () => {
  test('a closed holiday overrides normal hours, and the next opening is the next real day', () => {
    const status = statusAt(weekdays, [specialClosed('2026-11-02')], EST('2026-11-02T12:00:00'));
    expect(status.isOpen).toBe(false);
    expect(status.nextOpen).toEqual({ dayOfWeek: 2, time: '07:00', isToday: false });
  });

  test('reduced holiday hours replace the normal hours for that date only', () => {
    const hours = [special('2026-11-02', '10:00:00', '12:00:00')];
    expect(statusAt(weekdays, hours, EST('2026-11-02T08:00:00')).isOpen).toBe(false); // normally open
    expect(statusAt(weekdays, hours, EST('2026-11-02T11:00:00')).isOpen).toBe(true);
    expect(statusAt(weekdays, hours, EST('2026-11-02T13:00:00')).isOpen).toBe(false); // normally open
    expect(statusAt(weekdays, hours, EST('2026-11-03T08:00:00')).isOpen).toBe(true); // next day is normal again
  });

  test('special hours on a normally closed day can open it', () => {
    expect(
      statusAt(
        weekdays,
        [special('2026-11-07', '10:00:00', '14:00:00')],
        EST('2026-11-07T12:00:00')
      ).isOpen
    ).toBe(true);
  });

  test('a special period that runs past midnight carries into the next day', () => {
    const hours = [special('2026-11-07', '20:00:00', '03:00:00')];
    expect(statusAt([], hours, EST('2026-11-08T01:00:00')).isOpen).toBe(true);
    expect(statusAt([], hours, EST('2026-11-08T03:00:00')).isOpen).toBe(false);
  });

  test('special hours for other dates do not affect today', () => {
    expect(
      statusAt(weekdays, [specialClosed('2026-11-09')], EST('2026-11-02T12:00:00')).isOpen
    ).toBe(true);
  });

  test('a closed holiday also cancels an overnight period carried from the day before', () => {
    const lateNight = [row(5, '18:00:00', '02:00:00')];
    // Friday 6 Nov is a special closed day, so nothing carries into Saturday 01:00
    expect(
      statusAt(lateNight, [specialClosed('2026-11-06')], EST('2026-11-07T01:00:00')).isOpen
    ).toBe(false);
  });
});

describe('weeklySchedule', () => {
  test('gives seven days, Sunday first, with closed days marked', () => {
    const schedule = weeklySchedule([...weekdays, closedDay(0)]);
    expect(schedule).toHaveLength(7);
    expect(schedule.map((d) => d.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(schedule[0]).toEqual({ dayOfWeek: 0, isClosed: true, periods: [] });
    expect(schedule[6]).toEqual({ dayOfWeek: 6, isClosed: true, periods: [] });
    expect(schedule[1]).toEqual({
      dayOfWeek: 1,
      isClosed: false,
      periods: [{ opensAt: '07:00', closesAt: '20:00' }],
    });
  });

  test('lists several periods in time order and drops the seconds', () => {
    const schedule = weeklySchedule([
      row(2, '17:00:00', '20:00:00'),
      row(2, '11:00:00', '14:00:00'),
    ]);
    expect(schedule[2].periods).toEqual([
      { opensAt: '11:00', closesAt: '14:00' },
      { opensAt: '17:00', closesAt: '20:00' },
    ]);
  });
});

describe('upcomingSpecialHours', () => {
  const now = EST('2026-11-02T12:00:00');

  test('keeps today and later, drops the past, sorts by date', () => {
    const result = upcomingSpecialHours(
      [
        specialClosed('2026-11-26', 'Thanksgiving'),
        specialClosed('2026-10-01', 'Old'),
        special('2026-11-02', '10:00:00', '14:00:00'),
      ],
      now
    );
    expect(result.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-26']);
  });

  test('describes closed days with their note, and open days with their periods', () => {
    const [today, holiday] = upcomingSpecialHours(
      [special('2026-11-02', '10:00:00', '14:00:00'), specialClosed('2026-11-26', 'Thanksgiving')],
      now
    );
    expect(today).toEqual({
      date: '2026-11-02',
      note: null,
      isClosed: false,
      periods: [{ opensAt: '10:00', closesAt: '14:00' }],
    });
    expect(holiday).toEqual({
      date: '2026-11-26',
      note: 'Thanksgiving',
      isClosed: true,
      periods: [],
    });
  });

  test('merges several rows for one date', () => {
    const [entry] = upcomingSpecialHours(
      [
        special('2026-11-03', '10:00:00', '12:00:00'),
        special('2026-11-03', '16:00:00', '18:00:00'),
      ],
      now
    );
    expect(entry.periods).toHaveLength(2);
  });
});
