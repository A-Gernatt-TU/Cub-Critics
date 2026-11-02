'use strict';
// Mounts every route file under /api (see app.js). Feature routes are added here as
// they are built.
const express = require('express');
const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

module.exports = router;
