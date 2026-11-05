'use strict';
// Request rules for reviews and reports (FR#24-FR#31).
const { z } = require('zod');
const { safeText, queryInteger } = require('./common');
const { REPORT_REASON } = require('../constants/statuses');
const {
  RATING_MIN,
  RATING_MAX,
  REVIEW_MAX_LENGTH,
  REPORT_COMMENT_MAX_LENGTH,
} = require('../constants/limits');

const STAR_MESSAGE = `Please choose a star rating from ${RATING_MIN} to ${RATING_MAX}`;

// FR#24, FR#26: a whole number of stars. "5" (text) and 4.5 are refused.
const rating = z
  .number({ error: STAR_MESSAGE })
  .int(STAR_MESSAGE)
  .min(RATING_MIN, STAR_MESSAGE)
  .max(RATING_MAX, STAR_MESSAGE);

// FR#25: optional text of up to 1,000 characters. Blank means "no text".
const reviewText = safeText('Review', { max: REVIEW_MAX_LENGTH, multiline: true });

// POST /api/venues/:id/reviews
const createReviewSchema = z.object({
  rating,
  body: reviewText.nullish().transform((text) => text || null),
});

// PATCH /api/reviews/:id: send only what changes. `body: null` or "" removes the text.
const updateReviewSchema = z
  .object({
    rating: rating.optional(),
    body: reviewText.nullable().optional(),
  })
  .refine((data) => data.rating !== undefined || data.body !== undefined, {
    error: 'Send a new rating or new review text',
    path: ['rating'],
  });

// POST /api/reviews/:id/report (FR#31)
const reportSchema = z.object({
  reason: z.enum(Object.values(REPORT_REASON), { error: 'Please choose a reason for your report' }),
  comment: safeText('Comment', { max: REPORT_COMMENT_MAX_LENGTH, multiline: true })
    .nullish()
    .transform((text) => text || null),
});

// Paging for "my reviews" and a profile's reviews
const pagingQuerySchema = z.object({
  limit: queryInteger('Limit', { min: 1, max: 50 }),
  offset: queryInteger('Offset', { min: 0, max: 100000 }),
});

module.exports = { createReviewSchema, updateReviewSchema, reportSchema, pagingQuerySchema };
