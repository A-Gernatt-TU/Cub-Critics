'use strict';
// Writing, editing and deleting reviews (FR#24-FR#29). Every one of these needs a login.
const reviewService = require('../services/reviewService');

// FR#24-FR#27. Also reports any badge the review just earned (FR#16).
async function createReview({ userId, venueId, body }) {
  const { review, newAchievements } = await reviewService.createReview(userId, venueId, body);
  return { statusCode: 201, data: { review, newAchievements } };
}

// FR#27: the student's own review of this venue, or null if none yet.
async function getMyReview({ userId, venueId }) {
  return { data: { review: await reviewService.getMyReview(userId, venueId) } };
}

// FR#28
async function updateReview({ userId, id, body }) {
  return { data: { review: await reviewService.updateReview(userId, id, body) } };
}

// FR#29 (the "are you sure?" step, FR#62, is the frontend's job)
async function deleteReview({ userId, id }) {
  await reviewService.deleteReview(userId, id);
}

module.exports = { createReview, getMyReview, updateReview, deleteReview };
