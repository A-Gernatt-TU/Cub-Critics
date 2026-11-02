// Shared limits taken from the SRS.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Abuse limits (SC#6). They are per IP address, and campus Wi-Fi puts many students
// behind ONE address, so they are deliberately generous: they stop scripts, not people.
const RATE_LIMITS = Object.freeze({
  // Only FAILED logins count. The per-account lockout (FR#6) handles targeted guessing;
  // this stops one address trying many different accounts.
  login: { windowMs: 15 * MINUTE, limit: 20 },
  // Every attempt counts, including ones rejected as duplicates, which also slows down
  // anyone probing which emails are registered.
  register: { windowMs: HOUR, limit: 20 },
  // Used by the review and report endpoints (per logged-in account AND per IP).
  review: { windowMs: HOUR, perAccount: 30, perIp: 60 },
  report: { windowMs: HOUR, perAccount: 20, perIp: 60 },
});

module.exports = Object.freeze({
  RATE_LIMITS,
  PASSWORD_MIN_LENGTH: 8, // FR#3 (also needs a letter and a number)
  BIO_MAX_LENGTH: 250, // FR#12
  REVIEW_MAX_LENGTH: 1000, // FR#25
  RATING_MIN: 1, // FR#24
  RATING_MAX: 5,
  PROFILE_PICTURE_MAX_BYTES: 2 * 1024 * 1024, // FR#13
  VENUE_PHOTO_MAX_BYTES: 5 * 1024 * 1024, // FR#51
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png'],
  LOGIN_MAX_FAILURES: 5, // FR#6
  LOGIN_LOCK_MINUTES: 15,
  STUDENT_IDLE_MINUTES: 30, // SC#12
  ADMIN_IDLE_MINUTES: 15,
  AVERAGE_RATING_DECIMALS: 1, // FR#23: average rating shown to one decimal place
});
