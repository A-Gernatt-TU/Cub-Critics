'use strict';
// Request rules for profile changes (FR#12).
const { z } = require('zod');
const { safeText } = require('./common');
const { BIO_MAX_LENGTH } = require('../constants/limits');

// PATCH /api/users/me: { "bio": "text" }. An empty bio or null clears it.
const updateProfileSchema = z.object({
  bio: safeText('Bio', { max: BIO_MAX_LENGTH, multiline: true })
    .nullable()
    .transform((text) => text || null),
});

module.exports = { updateProfileSchema };
