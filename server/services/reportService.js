'use strict';
// Students reporting reviews (FR#31). A report moves a published review to "reported", which
// puts it in the moderators' queue; it stays visible until a moderator decides (FR#42).
const { UniqueConstraintError } = require('sequelize');
const { sequelize, Review, Report } = require('../models');
const {
  REVIEW_STATUS,
  PUBLIC_REVIEW_STATUSES,
  REPORT_REASON_LABELS,
} = require('../constants/statuses');
const { NotFoundError, ConflictError, BadRequestError } = require('../utils/httpExceptions');

const alreadyReported = () =>
  new ConflictError('You have already reported this review', { code: 'REPORT_ALREADY_FILED' });

function listReasons() {
  return Object.entries(REPORT_REASON_LABELS).map(([value, label]) => ({ value, label }));
}

async function createReport(reporterId, reviewId, { reason, comment }) {
  try {
    return await sequelize.transaction(async (transaction) => {
      // Lock the review so a moderator's decision and a new report cannot interleave.
      const review = await Review.findByPk(reviewId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      // Hidden and removed reviews are not visible, so as far as the reporter knows they are gone.
      if (!review || !PUBLIC_REVIEW_STATUSES.includes(review.status)) {
        throw new NotFoundError('Review not found');
      }
      if (review.user_id === reporterId) {
        throw new BadRequestError('You cannot report your own review', {
          code: 'CANNOT_REPORT_OWN_REVIEW',
        });
      }
      const already = await Report.findOne({
        where: { review_id: reviewId, reporter_id: reporterId },
        attributes: ['id'],
        transaction,
      });
      if (already) throw alreadyReported();

      const report = await Report.create(
        { review_id: reviewId, reporter_id: reporterId, reason, comment },
        { transaction }
      );
      if (review.status === REVIEW_STATUS.PUBLISHED) {
        await review.update({ status: REVIEW_STATUS.REPORTED }, { transaction });
      }
      return { id: report.id, reason: report.reason, createdAt: report.created_at };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw alreadyReported();
    throw err;
  }
}

module.exports = { listReasons, createReport };
