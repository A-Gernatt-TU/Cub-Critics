// Allowed values for status/enum-like columns. These mirror the CHECK constraints
// in the migrations; if you change one, change the other.

const USER_STATUS = Object.freeze({ ACTIVE: 'active', DEACTIVATED: 'deactivated' });

const VENUE_STATUS = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });

// Public: published, reported. Hidden: flagged, removed. (FR#42, FR#43)
const REVIEW_STATUS = Object.freeze({
  PUBLISHED: 'published',
  REPORTED: 'reported',
  FLAGGED: 'flagged',
  REMOVED: 'removed',
});
const PUBLIC_REVIEW_STATUSES = Object.freeze([REVIEW_STATUS.PUBLISHED, REVIEW_STATUS.REPORTED]);

const REPORT_STATUS = Object.freeze({ OPEN: 'open', CLOSED: 'closed' });

// Matches the ToS content rules in SF#1. Final list depends on TBD-5.
const REPORT_REASON = Object.freeze({
  HARASSMENT: 'harassment',
  HATE_SPEECH: 'hate_speech',
  THREATS: 'threats',
  PERSONAL_INFO: 'personal_info',
  SPAM: 'spam',
  OTHER: 'other',
});

// What the report form shows for each reason.
const REPORT_REASON_LABELS = Object.freeze({
  [REPORT_REASON.HARASSMENT]: 'Harassment',
  [REPORT_REASON.HATE_SPEECH]: 'Hate speech',
  [REPORT_REASON.THREATS]: 'Threats',
  [REPORT_REASON.PERSONAL_INFO]: 'Personal information',
  [REPORT_REASON.SPAM]: 'Spam',
  [REPORT_REASON.OTHER]: 'Other',
});

const MODERATION_ACTION = Object.freeze({ APPROVE: 'approve', FLAG: 'flag', REMOVE: 'remove' });

const values = (obj) => Object.values(obj);

module.exports = {
  USER_STATUS,
  VENUE_STATUS,
  REVIEW_STATUS,
  PUBLIC_REVIEW_STATUSES,
  REPORT_STATUS,
  REPORT_REASON,
  REPORT_REASON_LABELS,
  MODERATION_ACTION,
  values,
};
