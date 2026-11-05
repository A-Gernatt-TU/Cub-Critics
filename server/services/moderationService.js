'use strict';
// Moderation (FR#40-FR#44, FR#59, SF#2). Administrators approve, flag or remove reported
// reviews. Every decision is saved together with its log entry in ONE database transaction,
// so there is never a decision without a record of who made it and why.
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Review, Report, ModerationLog, User, Venue } = require('../models');
const {
  REVIEW_STATUS,
  REPORT_STATUS,
  MODERATION_ACTION,
  REPORT_REASON_LABELS,
} = require('../constants/statuses');
const { NotFoundError, ConflictError } = require('../utils/httpExceptions');

const AWAITING = [REVIEW_STATUS.REPORTED, REVIEW_STATUS.FLAGGED];

// What each decision does, and which states it may start from.
//  approve: the review is fine. Back to published; its open reports are closed (FR#42).
//  flag:    suspected violation. Hidden from the public at once, until a decision (FR#43, SF#2).
//  remove:  confirmed violation. Hidden for good, reason recorded, reports closed (FR#44).
const DECISIONS = Object.freeze({
  [MODERATION_ACTION.APPROVE]: {
    from: [REVIEW_STATUS.REPORTED, REVIEW_STATUS.FLAGGED],
    to: REVIEW_STATUS.PUBLISHED,
    closeReports: true,
    past: 'approved',
  },
  [MODERATION_ACTION.FLAG]: {
    from: [REVIEW_STATUS.PUBLISHED, REVIEW_STATUS.REPORTED],
    to: REVIEW_STATUS.FLAGGED,
    closeReports: false,
    past: 'flagged',
  },
  [MODERATION_ACTION.REMOVE]: {
    from: [REVIEW_STATUS.PUBLISHED, REVIEW_STATUS.REPORTED, REVIEW_STATUS.FLAGGED],
    to: REVIEW_STATUS.REMOVED,
    closeReports: true,
    past: 'removed',
  },
});

// FR#40: the numbers on the administrator dashboard.
async function getDashboard() {
  const [row] = await sequelize.query(
    [
      'SELECT',
      "(SELECT COUNT(*)::int FROM reviews WHERE status = 'reported') AS reported_reviews,",
      "(SELECT COUNT(*)::int FROM reviews WHERE status = 'flagged') AS flagged_reviews,",
      "(SELECT COUNT(*)::int FROM reports WHERE status = 'open') AS open_reports,",
      "(SELECT COUNT(*)::int FROM venues WHERE status = 'active') AS active_venues,",
      "(SELECT COUNT(*)::int FROM venues WHERE status = 'inactive') AS inactive_venues",
    ].join(' '),
    { type: QueryTypes.SELECT }
  );
  return {
    awaitingModeration: row.reported_reviews + row.flagged_reviews,
    reportedReviews: row.reported_reviews,
    flaggedReviews: row.flagged_reviews,
    openReports: row.open_reports,
    venues: { active: row.active_venues, inactive: row.inactive_venues },
  };
}

function serializeModerationReview(review) {
  return {
    id: review.id,
    rating: review.rating,
    body: review.body ?? null,
    status: review.status,
    createdAt: review.created_at,
    edited: review.edited_at !== null && review.edited_at !== undefined,
    editedAt: review.edited_at ?? null,
    author: review.author ? { id: review.author.id, username: review.author.username } : null,
    venue: review.venue ? { id: review.venue.id, name: review.venue.name } : null,
  };
}

function serializeReport(report) {
  return {
    id: report.id,
    reason: report.reason,
    reasonLabel: REPORT_REASON_LABELS[report.reason] || report.reason,
    comment: report.comment ?? null,
    createdAt: report.created_at,
    reporter: report.reporter
      ? { id: report.reporter.id, username: report.reporter.username }
      : null,
  };
}

// FR#41: reported and flagged reviews, longest-waiting first, each with its open reports
// (reason, comment, who reported, when).
async function listQueue({ status, limit = 20, offset = 0 }) {
  const statuses = status ? [status] : AWAITING;

  const total = await Review.count({ where: { status: { [Op.in]: statuses } } });
  const rows = await sequelize.query(
    [
      'SELECT q.id FROM (',
      'SELECT r.id, r.created_at,',
      "(SELECT MIN(rep.created_at) FROM reports rep WHERE rep.review_id = r.id AND rep.status = 'open') AS first_reported_at",
      'FROM reviews r WHERE r.status = ANY($statuses)',
      ') q ORDER BY COALESCE(q.first_reported_at, q.created_at) ASC, q.id ASC LIMIT $limit OFFSET $offset',
    ].join(' '),
    { bind: { statuses, limit, offset }, type: QueryTypes.SELECT }
  );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { items: [], total };

  const [reviews, reports] = await Promise.all([
    Review.findAll({
      where: { id: ids },
      include: [
        { model: User, as: 'author', attributes: ['id', 'username'] },
        { model: Venue, as: 'venue', attributes: ['id', 'name'] },
      ],
    }),
    Report.findAll({
      where: { review_id: ids, status: REPORT_STATUS.OPEN },
      include: [{ model: User, as: 'reporter', attributes: ['id', 'username'] }],
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
  ]);

  const byId = new Map(reviews.map((review) => [review.id, review]));
  return {
    items: ids.map((id) => ({
      review: serializeModerationReview(byId.get(id)),
      reports: reports.filter((report) => report.review_id === id).map(serializeReport),
    })),
    total,
  };
}

/**
 * Approve, flag or remove a review (FR#42, FR#43, FR#44) and log it (FR#59, AL#1).
 * The review row is locked while deciding, so two administrators acting on the same review at
 * the same moment are handled one after the other: the second sees the new state and is told.
 */
async function decide(adminId, reviewId, action, reason) {
  const rule = DECISIONS[action];

  await sequelize.transaction(async (transaction) => {
    const review = await Review.findByPk(reviewId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!review) throw new NotFoundError('Review not found');

    if (!rule.from.includes(review.status)) {
      throw new ConflictError(`This review cannot be ${rule.past} because it is ${review.status}`, {
        code: 'REVIEW_NOT_ACTIONABLE',
        details: { status: review.status },
      });
    }

    await review.update({ status: rule.to }, { transaction });
    if (rule.closeReports) {
      await Report.update(
        { status: REPORT_STATUS.CLOSED, closed_at: new Date() },
        { where: { review_id: review.id, status: REPORT_STATUS.OPEN }, transaction }
      );
    }
    // The log keeps a copy of the review as it was, in case the author later deletes it.
    await ModerationLog.create(
      {
        admin_id: adminId,
        review_id: review.id,
        action,
        reason,
        review_author_id: review.user_id,
        review_venue_id: review.venue_id,
        review_rating: review.rating,
        review_text: review.body,
      },
      { transaction }
    );
  });

  const review = await Review.findByPk(reviewId, {
    include: [
      { model: User, as: 'author', attributes: ['id', 'username'] },
      { model: Venue, as: 'venue', attributes: ['id', 'name'] },
    ],
  });
  return serializeModerationReview(review);
}

module.exports = { getDashboard, listQueue, decide };
