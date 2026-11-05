'use strict';
// Public venue pages (FR#17-FR#23, FR#30, FR#32-FR#39). Guests may use all of these (FR#9).
const venueService = require('../services/venueService');
const reviewService = require('../services/reviewService');

async function listCategories() {
  return { data: { categories: await venueService.listCategories() } };
}

// FR#32-FR#39: search, filters and sorting together; `total` = number of matches.
async function listVenues({ query }) {
  const { category, ...rest } = query;
  return { data: await venueService.listVenues({ ...rest, categoryIds: category }) };
}

async function getVenue({ id }) {
  return { data: { venue: await venueService.getVenueDetail(id) } };
}

async function listReviews({ id, query, viewerId }) {
  return { data: await reviewService.listVenueReviews(id, query, viewerId) };
}

module.exports = { listCategories, listVenues, getVenue, listReviews };
