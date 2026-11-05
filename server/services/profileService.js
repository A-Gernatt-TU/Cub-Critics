'use strict';
// Student profiles (FR#11-FR#15): public pages, bio, and profile picture.
const { sequelize, User, Review } = require('../models');
const { PUBLIC_REVIEW_STATUSES, USER_STATUS } = require('../constants/statuses');
const { Op } = require('sequelize');
const achievementService = require('./achievementService');
const storageService = require('./storageService');
const logger = require('../utils/logger');
const { serializeOwnUser } = require('../utils/serializers');
const { NotFoundError } = require('../utils/httpExceptions');

// What anyone may see about a student (FR#15, SF#4): never the email, role or login details.
async function getPublicProfile(userId) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'username', 'bio', 'profile_picture_key', 'created_at', 'status'],
  });
  if (!user || user.status !== USER_STATUS.ACTIVE) throw new NotFoundError('Profile not found');

  const [reviewCount, achievements] = await Promise.all([
    Review.count({ where: { user_id: userId, status: { [Op.in]: PUBLIC_REVIEW_STATUSES } } }),
    achievementService.listForUser(userId),
  ]);

  return {
    id: user.id,
    username: user.username,
    bio: user.bio ?? null,
    profilePictureUrl: storageService.urlFor(user.profile_picture_key),
    joinedAt: user.created_at,
    reviewCount,
    achievements,
  };
}

async function requireActiveUser(userId) {
  const user = await User.findByPk(userId, { attributes: ['id', 'status'] });
  if (!user || user.status !== USER_STATUS.ACTIVE) throw new NotFoundError('Profile not found');
}

// FR#12
async function updateBio(userId, bio) {
  await User.update({ bio }, { where: { id: userId } });
  return serializeOwnUser(await User.findByPk(userId));
}

// FR#13: saves the new picture, points the account at it, then removes the old file. If the
// database update fails, the new file is removed again so nothing is left behind.
async function setProfilePicture(userId, image) {
  const key = await storageService.saveImage({
    folder: storageService.FOLDERS.PROFILE_PICTURES,
    buffer: image.buffer,
    extension: image.extension,
  });

  let previousKey;
  try {
    await sequelize.transaction(async (transaction) => {
      const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      previousKey = user.profile_picture_key;
      await user.update({ profile_picture_key: key }, { transaction });
    });
  } catch (err) {
    await storageService.deleteImage(key).catch(() => {});
    throw err;
  }

  if (previousKey) {
    await storageService.deleteImage(previousKey).catch((err) => {
      logger.warn({ err, key: previousKey }, 'Could not remove replaced profile picture');
    });
  }
  return serializeOwnUser(await User.findByPk(userId));
}

module.exports = { getPublicProfile, requireActiveUser, updateBio, setProfilePicture };
