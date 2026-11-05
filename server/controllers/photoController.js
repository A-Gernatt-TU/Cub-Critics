'use strict';
// Administrator venue photo management (FR#51, FR#52).
const photoService = require('../services/photoService');

async function addPhoto({ adminId, venueId, image, ip }) {
  return {
    statusCode: 201,
    data: { photo: await photoService.addPhoto(adminId, venueId, image, ip) },
  };
}

async function removePhoto({ adminId, id, ip }) {
  await photoService.removePhoto(adminId, id, ip);
}

module.exports = { addPhoto, removePhoto };
