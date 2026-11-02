'use strict';
const storageService = require('../services/storageService');

// Turns database rows into the JSON the frontend receives (camelCase). Fields are listed
// explicitly, so a column added later is never exposed by accident (SF#4, SC#9).

// The logged-in person's own account. Includes their email; never the password hash.
function serializeOwnUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    bio: user.bio ?? null,
    profilePictureUrl: storageService.urlFor(user.profile_picture_key),
    createdAt: user.created_at,
  };
}

module.exports = { serializeOwnUser };
