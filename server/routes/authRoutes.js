'use strict';
// /api/auth/*  (FR#1-FR#7)
//   POST /register  create a student account and log in
//   POST /login     log in with email + password
//   POST /logout    end the session
//   GET  /me        who is logged in ({ user: null } for guests)
const express = require('express');
const { createHandler } = require('../utils/handler');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../validators/authSchemas');
const authController = require('../controllers/authController');

const router = express.Router();

// Account responses must never be cached by the browser or a proxy.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post(
  '/register',
  validate({ body: registerSchema }),
  createHandler((req) => ({ body: req.validated.body, ip: req.ip }), authController.register)
);

router.post(
  '/login',
  validate({ body: loginSchema }),
  createHandler((req) => ({ body: req.validated.body, ip: req.ip }), authController.login)
);

router.post(
  '/logout',
  createHandler((req) => ({ ip: req.ip }), authController.logout)
);

router.get(
  '/me',
  createHandler(() => ({}), authController.me)
);

module.exports = router;
