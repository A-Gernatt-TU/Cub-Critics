'use strict';
// Mounts every route file under /api (see app.js). Feature routes are added here as
// they are built.
const express = require('express');
const healthRoutes = require('./healthRoutes');
const authRoutes = require('./authRoutes');
const venueRoutes = require('./venueRoutes');
const reviewRoutes = require('./reviewRoutes');
const profileRoutes = require('./profileRoutes');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/', venueRoutes); // /categories and /venues/...
router.use('/', reviewRoutes); // /venues/:id/reviews (write), /reviews/...
router.use('/users', profileRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
