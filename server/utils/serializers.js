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

// A venue in the directory list (FR#18).
function serializeVenueSummary(row, { rating, openStatus, matchedMenuItems }) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    location: row.location ?? null,
    category: { id: row.category_id, name: row.category_name },
    thumbnailUrl: storageService.urlFor(row.thumbnail_key),
    avgRating: rating.avgRating,
    reviewCount: rating.reviewCount,
    openStatus,
    ...(matchedMenuItems ? { matchedMenuItems } : {}),
  };
}

// DECIMAL columns arrive as text ("8.50"); the API sends numbers.
function serializeMenuItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? null,
    price: Number(item.price),
  };
}

function serializePhoto(photo) {
  return { id: photo.id, url: storageService.urlFor(photo.storage_key) };
}

// A review as other people see it (FR#30, SF#4: username only, never email or real name).
// Pass the viewer's id to flag their own review; pass includeStatus for the author's/admin's view.
function serializeReview(review, { viewerId = null, includeStatus = false } = {}) {
  const author = review.author;
  return {
    id: review.id,
    rating: review.rating,
    body: review.body ?? null,
    createdAt: review.created_at,
    edited: review.edited_at !== null && review.edited_at !== undefined,
    editedAt: review.edited_at ?? null,
    author: author
      ? {
          id: author.id,
          username: author.username,
          profilePictureUrl: storageService.urlFor(author.profile_picture_key),
        }
      : null,
    mine: viewerId !== null && review.user_id === viewerId,
    ...(includeStatus ? { status: review.status } : {}),
  };
}

// A review shown on a profile or in "my reviews": which venue it is for (FR#14, FR#15).
function serializeProfileReview(review, { includeStatus = false } = {}) {
  return {
    id: review.id,
    rating: review.rating,
    body: review.body ?? null,
    createdAt: review.created_at,
    edited: review.edited_at !== null && review.edited_at !== undefined,
    editedAt: review.edited_at ?? null,
    venue: review.venue ? { id: review.venue.id, name: review.venue.name } : null,
    ...(includeStatus ? { status: review.status } : {}),
  };
}

module.exports = {
  serializeProfileReview,
  serializeOwnUser,
  serializeVenueSummary,
  serializeMenuItem,
  serializePhoto,
  serializeReview,
};
