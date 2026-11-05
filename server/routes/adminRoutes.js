'use strict';
// Everything under /api/admin needs an administrator (FR#8, FR#10, SC#10, SC#14). A guest gets
// 401 and a student gets 403 "Access denied", whatever URL under /api/admin they try.
//
//   GET    /api/admin/dashboard                      numbers for the dashboard           (FR#40)
//   GET    /api/admin/moderation/queue               ?status=reported|flagged &limit &offset (FR#41)
//   POST   /api/admin/reviews/:id/approve            { reason? }                         (FR#42)
//   POST   /api/admin/reviews/:id/flag               { reason? }                         (FR#43)
//   POST   /api/admin/reviews/:id/remove             { reason }  reason required         (FR#44)
//   GET    /api/admin/venues                         every venue incl. deactivated
//   GET    /api/admin/venues/:id                     one venue incl. status
//   POST   /api/admin/venues                         { name, categoryId, description, location, hours, specialHours? } (FR#45)
//   PATCH  /api/admin/venues/:id                     any of the above; hours/specialHours replace the list (FR#46)
//   POST   /api/admin/venues/:id/deactivate          hide from directory and search      (FR#47)
//   POST   /api/admin/venues/:id/reactivate
//   POST   /api/admin/venues/:id/menu-items          { name, description?, price }       (FR#48)
//   PATCH  /api/admin/menu-items/:id                                                      (FR#49)
//   DELETE /api/admin/menu-items/:id                                                      (FR#50)
//   POST   /api/admin/venues/:id/photos              multipart field "file", JPG/PNG up to 5 MB (FR#51)
//   DELETE /api/admin/photos/:id                                                          (FR#52)
//   POST   /api/admin/categories  PATCH/DELETE /api/admin/categories/:id
const express = require('express');
const { createHandler } = require('../utils/handler');
const validate = require('../middleware/validate');
const idParam = require('../middleware/idParam');
const requireRole = require('../middleware/requireRole');
const { uploadImage } = require('../middleware/upload');
const { uploadLimiters } = require('../middleware/rateLimiters');
const { ROLE } = require('../constants/roles');
const { VENUE_PHOTO_MAX_BYTES } = require('../constants/limits');
const {
  createVenueSchema,
  updateVenueSchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  categorySchema,
} = require('../validators/venueSchemas');
const { noteSchema, removeSchema, queueQuerySchema } = require('../validators/moderationSchemas');
const moderationController = require('../controllers/moderationController');
const adminVenueController = require('../controllers/adminVenueController');
const menuController = require('../controllers/menuController');
const photoController = require('../controllers/photoController');
const categoryController = require('../controllers/categoryController');

const router = express.Router();
router.param('id', idParam);
router.use(requireRole(ROLE.ADMINISTRATOR));

// What every handler needs to know about who is acting.
const actor = (req) => ({ adminId: req.user.id, ip: req.ip });
const withId = (req) => ({ ...actor(req), id: Number(req.params.id) });
const withBody = (req) => ({ ...withId(req), body: req.validated.body });

// ---- dashboard and moderation ----
router.get(
  '/dashboard',
  createHandler(() => ({}), moderationController.getDashboard)
);

router.get(
  '/moderation/queue',
  validate({ query: queueQuerySchema }),
  createHandler((req) => ({ query: req.validated.query }), moderationController.getQueue)
);

router.post(
  '/reviews/:id/approve',
  validate({ body: noteSchema }),
  createHandler(withBody, moderationController.approve)
);
router.post(
  '/reviews/:id/flag',
  validate({ body: noteSchema }),
  createHandler(withBody, moderationController.flag)
);
router.post(
  '/reviews/:id/remove',
  validate({ body: removeSchema }),
  createHandler(withBody, moderationController.remove)
);

// ---- venues ----
router.get(
  '/venues',
  createHandler(() => ({}), adminVenueController.listVenues)
);
router.get('/venues/:id', createHandler(withId, adminVenueController.getVenue));
router.post(
  '/venues',
  validate({ body: createVenueSchema }),
  createHandler(
    (req) => ({ ...actor(req), body: req.validated.body }),
    adminVenueController.createVenue
  )
);
router.patch(
  '/venues/:id',
  validate({ body: updateVenueSchema }),
  createHandler(withBody, adminVenueController.updateVenue)
);
router.post('/venues/:id/deactivate', createHandler(withId, adminVenueController.deactivate));
router.post('/venues/:id/reactivate', createHandler(withId, adminVenueController.reactivate));

// ---- menu items ----
router.post(
  '/venues/:id/menu-items',
  validate({ body: createMenuItemSchema }),
  createHandler(
    (req) => ({ ...actor(req), venueId: Number(req.params.id), body: req.validated.body }),
    menuController.createItem
  )
);
router.patch(
  '/menu-items/:id',
  validate({ body: updateMenuItemSchema }),
  createHandler(withBody, menuController.updateItem)
);
router.delete('/menu-items/:id', createHandler(withId, menuController.deleteItem));

// ---- photos ----
router.post(
  '/venues/:id/photos',
  ...uploadLimiters,
  ...uploadImage({ maxBytes: VENUE_PHOTO_MAX_BYTES, label: 'Photo' }),
  createHandler(
    (req) => ({ ...actor(req), venueId: Number(req.params.id), image: req.image }),
    photoController.addPhoto
  )
);
router.delete('/photos/:id', createHandler(withId, photoController.removePhoto));

// ---- categories ----
router.post(
  '/categories',
  validate({ body: categorySchema }),
  createHandler(
    (req) => ({ ...actor(req), body: req.validated.body }),
    categoryController.createCategory
  )
);
router.patch(
  '/categories/:id',
  validate({ body: categorySchema }),
  createHandler(withBody, categoryController.renameCategory)
);
router.delete('/categories/:id', createHandler(withId, categoryController.deleteCategory));

module.exports = router;
