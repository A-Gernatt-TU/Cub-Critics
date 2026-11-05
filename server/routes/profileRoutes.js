'use strict';
// Profile endpoints, mounted at /api/users.
//   GET   /api/users/me/reviews     my review history incl. each review's status   (login)
//   PATCH /api/users/me             change my bio  { bio }                           (login)
//   PUT   /api/users/me/picture     upload my picture, multipart field "file"        (login)
//   GET   /api/users/:id            a student's public profile                       (anyone)
//   GET   /api/users/:id/reviews    their public reviews                             (anyone)
// (Who am I, including my email? GET /api/auth/me.)
const express = require('express');
const { createHandler } = require('../utils/handler');
const validate = require('../middleware/validate');
const idParam = require('../middleware/idParam');
const requireAuth = require('../middleware/requireAuth');
const { uploadImage } = require('../middleware/upload');
const { uploadLimiters } = require('../middleware/rateLimiters');
const { updateProfileSchema } = require('../validators/profileSchemas');
const { pagingQuerySchema } = require('../validators/reviewSchemas');
const { PROFILE_PICTURE_MAX_BYTES } = require('../constants/limits');
const profileController = require('../controllers/profileController');

const router = express.Router();
router.param('id', idParam);

// "me" routes first, so "me" is never mistaken for an id.
router.get(
  '/me/reviews',
  requireAuth,
  validate({ query: pagingQuerySchema }),
  createHandler(
    (req) => ({ userId: req.user.id, query: req.validated.query }),
    profileController.getMyReviews
  )
);

router.patch(
  '/me',
  requireAuth,
  validate({ body: updateProfileSchema }),
  createHandler(
    (req) => ({ userId: req.user.id, body: req.validated.body }),
    profileController.updateMe
  )
);

router.put(
  '/me/picture',
  requireAuth,
  ...uploadLimiters,
  ...uploadImage({ maxBytes: PROFILE_PICTURE_MAX_BYTES, label: 'Profile picture' }),
  createHandler(
    (req) => ({ userId: req.user.id, image: req.image }),
    profileController.uploadPicture
  )
);

router.get(
  '/:id',
  createHandler((req) => ({ id: Number(req.params.id) }), profileController.getProfile)
);

router.get(
  '/:id/reviews',
  validate({ query: pagingQuerySchema }),
  createHandler(
    (req) => ({ id: Number(req.params.id), query: req.validated.query }),
    profileController.getUserReviews
  )
);

module.exports = router;
