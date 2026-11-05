'use strict';
// Public venue endpoints. No login needed (FR#9).
//   GET /api/categories                 categories for the filter menu
//   GET /api/venues                     directory: ?q= &category=1,2 &minRating= &openNow= &sort=name|rating &limit=
//   GET /api/venues/:id                 one venue: hours, photos, menu, rating
//   GET /api/venues/:id/reviews         its reviews: ?sort=newest|oldest|highest|lowest &limit= &offset=
const express = require('express');
const { createHandler } = require('../utils/handler');
const validate = require('../middleware/validate');
const idParam = require('../middleware/idParam');
const optionalAuth = require('../middleware/optionalAuth');
const { venueListQuerySchema, reviewListQuerySchema } = require('../validators/venueSchemas');
const venueController = require('../controllers/venueController');

const router = express.Router();
router.param('id', idParam);

router.get(
  '/categories',
  createHandler(() => ({}), venueController.listCategories)
);

router.get(
  '/venues',
  validate({ query: venueListQuerySchema }),
  createHandler((req) => ({ query: req.validated.query }), venueController.listVenues)
);

router.get(
  '/venues/:id',
  createHandler((req) => ({ id: Number(req.params.id) }), venueController.getVenue)
);

router.get(
  '/venues/:id/reviews',
  optionalAuth,
  validate({ query: reviewListQuerySchema }),
  createHandler(
    (req) => ({
      id: Number(req.params.id),
      query: req.validated.query,
      viewerId: req.user ? req.user.id : null,
    }),
    venueController.listReviews
  )
);

module.exports = router;
