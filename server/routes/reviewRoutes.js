'use strict';
// Student endpoints for reviews and reports. All need a login.
//   GET    /api/reviews/report-reasons     menu for the report form
//   POST   /api/venues/:id/reviews         post a review  { rating: 1-5, body?: text }
//   GET    /api/venues/:id/reviews/mine    my review of this venue, or { review: null }
//   PATCH  /api/reviews/:id                edit my review { rating?, body? }
//   DELETE /api/reviews/:id                delete my review
//   POST   /api/reviews/:id/report         report someone else's review { reason, comment? }
const express = require('express');
const { createHandler } = require('../utils/handler');
const validate = require('../middleware/validate');
const idParam = require('../middleware/idParam');
const requireAuth = require('../middleware/requireAuth');
const { reviewWriteLimiters, reportWriteLimiters } = require('../middleware/rateLimiters');
const {
  createReviewSchema,
  updateReviewSchema,
  reportSchema,
} = require('../validators/reviewSchemas');
const reviewController = require('../controllers/reviewController');
const reportController = require('../controllers/reportController');

const router = express.Router();
router.param('id', idParam);

router.get(
  '/reviews/report-reasons',
  createHandler(() => ({}), reportController.listReasons)
);

router.post(
  '/venues/:id/reviews',
  requireAuth,
  ...reviewWriteLimiters,
  validate({ body: createReviewSchema }),
  createHandler(
    (req) => ({ userId: req.user.id, venueId: Number(req.params.id), body: req.validated.body }),
    reviewController.createReview
  )
);

router.get(
  '/venues/:id/reviews/mine',
  requireAuth,
  createHandler(
    (req) => ({ userId: req.user.id, venueId: Number(req.params.id) }),
    reviewController.getMyReview
  )
);

router.patch(
  '/reviews/:id',
  requireAuth,
  ...reviewWriteLimiters,
  validate({ body: updateReviewSchema }),
  createHandler(
    (req) => ({ userId: req.user.id, id: Number(req.params.id), body: req.validated.body }),
    reviewController.updateReview
  )
);

router.delete(
  '/reviews/:id',
  requireAuth,
  ...reviewWriteLimiters,
  createHandler(
    (req) => ({ userId: req.user.id, id: Number(req.params.id) }),
    reviewController.deleteReview
  )
);

router.post(
  '/reviews/:id/report',
  requireAuth,
  ...reportWriteLimiters,
  validate({ body: reportSchema }),
  createHandler(
    (req) => ({ userId: req.user.id, id: Number(req.params.id), body: req.validated.body }),
    reportController.createReport
  )
);

module.exports = router;
