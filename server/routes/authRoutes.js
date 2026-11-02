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
const { loginLimiter, registerLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post(
  '/register',
  registerLimiter,
  validate({ body: registerSchema }),
  createHandler((req) => ({ body: req.validated.body, ip: req.ip }), authController.register)
);

router.post(
  '/login',
  loginLimiter,
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
