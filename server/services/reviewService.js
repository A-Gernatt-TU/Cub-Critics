'use strict';
// Reading (FR#30), writing (FR#24-FR#27), editing (FR#28) and deleting (FR#29) reviews.
const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize, Review, User, Venue } = require('../models');
const { VENUE_STATUS, REVIEW_STATUS, PUBLIC_REVIEW_STATUSES } = require('../constants/statuses');
const { serializeReview, serializeProfileReview } = require('../utils/serializers');
const achievementService = require('./achievementService');
const { NotFoundError, ForbiddenError, ConflictError } = require('../utils/httpExceptions');

const AUTHOR_ATTRIBUTES = ['id', 'username', 'profile_picture_key'];

const ORDERS = Object.freeze({
  newest: [
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ],
  oldest: [
    ['created_at', 'ASC'],
    ['id', 'ASC'],
  ],
  highest: [
    ['rating', 'DESC'],
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ],
  lowest: [
    ['rating', 'ASC'],
    ['created_at', 'DESC'],
    ['id', 'DESC'],
  ],
});

async function requireActiveVenue(venueId) {
  const venue = await Venue.findOne({
    where: { id: venueId, status: VENUE_STATUS.ACTIVE },
    attributes: ['id'],
  });
  if (!venue) throw new NotFoundError('Venue not found');
}

// A venue's published reviews, newest first by default (FR#30). `viewerId` marks the
// viewer's own review with mine: true.
async function listVenueReviews(
  venueId,
  { sort = 'newest', limit = 20, offset = 0 },
  viewerId = null
) {
  await requireActiveVenue(venueId);

  const { rows, count } = await Review.findAndCountAll({
    where: { venue_id: venueId, status: { [Op.in]: PUBLIC_REVIEW_STATUSES } },
    include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES }],
    order: ORDERS[sort],
    limit,
    offset,
  });

  return {
    reviews: rows.map((review) => serializeReview(review, { viewerId })),
    total: count,
  };
}

// A review's moderation state decides what its author may still do. Once a moderator has
// flagged or removed it, the author can neither edit nor delete it: otherwise someone could
// delete a removed review and simply post a fresh one.
const LOCKED_STATUSES = [REVIEW_STATUS.FLAGGED, REVIEW_STATUS.REMOVED];

const reviewLocked = () =>
  new ConflictError('This review is with a moderator and cannot be changed right now', {
    code: 'REVIEW_LOCKED',
  });

async function loadWithAuthor(id) {
  return Review.findByPk(id, {
    include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES }],
  });
}

// The student's own review of a venue, whatever its state, or null. The review form uses this:
// when one exists it opens for editing instead of showing a blank form (FR#27).
async function getMyReview(userId, venueId) {
  await requireActiveVenue(venueId);
  const review = await Review.findOne({
    where: { user_id: userId, venue_id: venueId },
    include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES }],
  });
  return review ? serializeReview(review, { viewerId: userId, includeStatus: true }) : null;
}

// FR#24-FR#27. One review per student per venue; the database enforces it too, so two
// simultaneous requests cannot both succeed.
async function createReview(userId, venueId, { rating, body }) {
  await requireActiveVenue(venueId);

  const existing = await Review.findOne({
    where: { user_id: userId, venue_id: venueId },
    attributes: ['id', 'status'],
  });
  if (existing) throw alreadyReviewedError(existing);

  try {
    const { reviewId, newAchievements } = await sequelize.transaction(async (transaction) => {
      const created = await Review.create(
        { user_id: userId, venue_id: venueId, rating, body },
        { transaction }
      );
      // FR#16: the badge appears as soon as the review that earns it is posted.
      const achievements = await achievementService.awardBadges(userId, { transaction });
      return { reviewId: created.id, newAchievements: achievements };
    });
    const review = await loadWithAuthor(reviewId);
    return {
      review: serializeReview(review, { viewerId: userId, includeStatus: true }),
      newAchievements,
    };
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const winner = await Review.findOne({
        where: { user_id: userId, venue_id: venueId },
        attributes: ['id', 'status'],
      });
      if (winner) throw alreadyReviewedError(winner);
    }
    throw err;
  }
}

function alreadyReviewedError(existing) {
  if (existing.status === REVIEW_STATUS.REMOVED) {
    return new ConflictError(
      'Your earlier review of this venue was removed by a moderator, so you cannot post another',
      { code: 'REVIEW_REMOVED' }
    );
  }
  return new ConflictError(
    'You have already reviewed this venue. You can edit your review instead',
    {
      code: 'REVIEW_ALREADY_EXISTS',
      details: { reviewId: existing.id },
    }
  );
}

// Finds a review for its owner to change, with the row locked until the transaction ends.
// Someone else's review is refused (SC#11); a missing one is a 404.
async function lockOwnReview(reviewId, userId, transaction) {
  const review = await Review.findByPk(reviewId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!review) throw new NotFoundError('Review not found');
  if (review.user_id !== userId) throw new ForbiddenError();
  if (LOCKED_STATUSES.includes(review.status)) throw reviewLocked();
  return review;
}

// FR#28: change the rating and/or text. The review is labeled "edited" with the date, but
// only if something really changed.
async function updateReview(userId, reviewId, changes) {
  await sequelize.transaction(async (transaction) => {
    const review = await lockOwnReview(reviewId, userId, transaction);

    const next = {};
    if (changes.rating !== undefined && changes.rating !== review.rating)
      next.rating = changes.rating;
    if (changes.body !== undefined) {
      const body = changes.body || null;
      if (body !== review.body) next.body = body;
    }
    if (Object.keys(next).length > 0) {
      await review.update({ ...next, edited_at: new Date() }, { transaction });
    }
  });

  const review = await loadWithAuthor(reviewId);
  return serializeReview(review, { viewerId: userId, includeStatus: true });
}

// FR#29. The review is removed for good; the venue's average updates by itself.
async function deleteReview(userId, reviewId) {
  await sequelize.transaction(async (transaction) => {
    const review = await lockOwnReview(reviewId, userId, transaction);
    await review.destroy({ transaction });
  });
}

// FR#14: every review the student has written, with the venue and its state, newest first.
async function listMyReviews(userId, { limit = 20, offset = 0 }) {
  const { rows, count } = await Review.findAndCountAll({
    where: { user_id: userId },
    include: [{ model: Venue, as: 'venue', attributes: ['id', 'name'] }],
    order: ORDERS.newest,
    limit,
    offset,
  });
  return {
    reviews: rows.map((r) => serializeProfileReview(r, { includeStatus: true })),
    total: count,
  };
}

// FR#15: a student's publicly visible reviews, for their public profile.
async function listReviewsByUser(userId, { limit = 20, offset = 0 }) {
  const { rows, count } = await Review.findAndCountAll({
    where: { user_id: userId, status: { [Op.in]: PUBLIC_REVIEW_STATUSES } },
    include: [
      {
        model: Venue,
        as: 'venue',
        attributes: ['id', 'name'],
        where: { status: VENUE_STATUS.ACTIVE },
      },
    ],
    order: ORDERS.newest,
    limit,
    offset,
  });
  return { reviews: rows.map((r) => serializeProfileReview(r)), total: count };
}

module.exports = {
  listVenueReviews,
  requireActiveVenue,
  getMyReview,
  createReview,
  updateReview,
  deleteReview,
  listMyReviews,
  listReviewsByUser,
  AUTHOR_ATTRIBUTES,
  ORDERS,
};
