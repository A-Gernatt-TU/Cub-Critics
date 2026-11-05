'use strict';
// Administrator venue management (FR#45-FR#47).
const venueAdminService = require('../services/venueAdminService');
const venueService = require('../services/venueService');
const { VENUE_STATUS } = require('../constants/statuses');

async function listVenues() {
  return { data: { venues: await venueAdminService.listVenues() } };
}

// Like the public page, but also works for deactivated venues and shows the status.
async function getVenue({ id }) {
  return { data: { venue: await venueService.getVenueDetail(id, { includeInactive: true }) } };
}

async function createVenue({ adminId, body, ip }) {
  return {
    statusCode: 201,
    data: { venue: await venueAdminService.createVenue(adminId, body, ip) },
  };
}

async function updateVenue({ adminId, id, body, ip }) {
  return { data: { venue: await venueAdminService.updateVenue(adminId, id, body, ip) } };
}

const statusChange = (status) =>
  async function change({ adminId, id, ip }) {
    return { data: { venue: await venueAdminService.setVenueStatus(adminId, id, status, ip) } };
  };

module.exports = {
  listVenues,
  getVenue,
  createVenue,
  updateVenue,
  deactivate: statusChange(VENUE_STATUS.INACTIVE),
  reactivate: statusChange(VENUE_STATUS.ACTIVE),
};
