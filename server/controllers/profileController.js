'use strict';
// Profiles (FR#11-FR#15).
const profileService = require('../services/profileService');
const reviewService = require('../services/reviewService');

// FR#11, FR#15: anyone can open a student's profile.
async function getProfile({ id }) {
  return { data: { user: await profileService.getPublicProfile(id) } };
}

// A student's public reviews, for their profile page (FR#15).
async function getUserReviews({ id, query }) {
  await profileService.requireActiveUser(id);
  return { data: await reviewService.listReviewsByUser(id, query) };
}

// FR#14: my own review history, including each review's status.
async function getMyReviews({ userId, query }) {
  return { data: await reviewService.listMyReviews(userId, query) };
}

// FR#12
async function updateMe({ userId, body }) {
  return { data: { user: await profileService.updateBio(userId, body.bio) } };
}

// FR#13: the upload middleware has already checked the file; `image` is the checked result.
async function uploadPicture({ userId, image }) {
  return { data: { user: await profileService.setProfilePicture(userId, image) } };
}

module.exports = { getProfile, getUserReviews, getMyReviews, updateMe, uploadPicture };
