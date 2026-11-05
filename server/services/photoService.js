'use strict';
// Administrators manage venue photos (FR#51, FR#52, FR#60, AL#2). The image file is saved
// first, then the database row; if anything fails the file is removed again, so no orphaned
// files pile up. A removed photo's file is deleted after its row is gone.
const { sequelize, Venue, VenuePhoto } = require('../models');
const storageService = require('./storageService');
const audit = require('./auditService');
const logger = require('../utils/logger');
const { VENUE_PHOTO_MAX_COUNT } = require('../constants/limits');
const { serializePhoto } = require('../utils/serializers');
const { NotFoundError, ConflictError } = require('../utils/httpExceptions');

async function addPhoto(adminId, venueId, image, ip) {
  if (!(await Venue.findByPk(venueId, { attributes: ['id'] })))
    throw new NotFoundError('Venue not found');

  const key = await storageService.saveImage({
    folder: storageService.FOLDERS.VENUE_PHOTOS,
    buffer: image.buffer,
    extension: image.extension,
  });

  try {
    const photo = await sequelize.transaction(async (transaction) => {
      const venue = await Venue.findByPk(venueId, {
        attributes: ['id'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!venue) throw new NotFoundError('Venue not found');

      const where = { venue_id: venueId };
      if ((await VenuePhoto.count({ where, transaction })) >= VENUE_PHOTO_MAX_COUNT) {
        throw new ConflictError(`A venue can have at most ${VENUE_PHOTO_MAX_COUNT} photos`, {
          code: 'PHOTO_LIMIT_REACHED',
        });
      }
      const highest = await VenuePhoto.max('sort_order', { where, transaction });
      const created = await VenuePhoto.create(
        {
          venue_id: venueId,
          storage_key: key,
          original_filename: image.originalFilename,
          sort_order: (highest ?? -1) + 1,
          uploaded_by: adminId,
        },
        { transaction }
      );
      await audit.recordInTransaction(
        {
          actorId: adminId,
          eventType: audit.EVENTS.PHOTO_ADDED,
          entityType: 'venue_photo',
          entityId: created.id,
          ip,
          details: { venueId },
        },
        transaction
      );
      return created;
    });
    return serializePhoto(photo);
  } catch (err) {
    await storageService.deleteImage(key).catch(() => {});
    throw err;
  }
}

async function removePhoto(adminId, photoId, ip) {
  const key = await sequelize.transaction(async (transaction) => {
    const photo = await VenuePhoto.findByPk(photoId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!photo) throw new NotFoundError('Photo not found');
    await photo.destroy({ transaction });
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.PHOTO_REMOVED,
        entityType: 'venue_photo',
        entityId: photoId,
        ip,
        details: { venueId: photo.venue_id },
      },
      transaction
    );
    return photo.storage_key;
  });

  await storageService.deleteImage(key).catch((err) => {
    logger.warn({ err, key }, 'Could not remove the file of a deleted venue photo');
  });
}

module.exports = { addPhoto, removePhoto };
