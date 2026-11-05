'use strict';
// Administrators manage venue categories (SQ#6, FR#34): no code change needed to add one.
const { UniqueConstraintError } = require('sequelize');
const { sequelize, Category, Venue } = require('../models');
const audit = require('./auditService');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/httpExceptions');

const duplicateName = () =>
  new ValidationError(undefined, [
    { field: 'name', message: 'A category with that name already exists' },
  ]);

const serialize = (category) => ({ id: category.id, name: category.name });

async function createCategory(adminId, { name }, ip) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const category = await Category.create({ name }, { transaction });
      await audit.recordInTransaction(
        {
          actorId: adminId,
          eventType: audit.EVENTS.CATEGORY_CREATED,
          entityType: 'category',
          entityId: category.id,
          ip,
          details: { name },
        },
        transaction
      );
      return serialize(category);
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw duplicateName();
    throw err;
  }
}

async function renameCategory(adminId, id, { name }, ip) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const category = await Category.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!category) throw new NotFoundError('Category not found');
      const previous = category.name;
      await category.update({ name }, { transaction });
      await audit.recordInTransaction(
        {
          actorId: adminId,
          eventType: audit.EVENTS.CATEGORY_UPDATED,
          entityType: 'category',
          entityId: id,
          ip,
          details: { from: previous, to: name },
        },
        transaction
      );
      return serialize(category);
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw duplicateName();
    throw err;
  }
}

// A category that venues still use cannot be deleted; move or deactivate those venues first.
async function deleteCategory(adminId, id, ip) {
  await sequelize.transaction(async (transaction) => {
    const category = await Category.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!category) throw new NotFoundError('Category not found');

    const inUse = await Venue.count({ where: { category_id: id }, transaction });
    if (inUse > 0) {
      throw new ConflictError(
        `${inUse === 1 ? '1 venue uses' : `${inUse} venues use`} this category, so it cannot be deleted`,
        {
          code: 'CATEGORY_IN_USE',
          details: { venueCount: inUse },
        }
      );
    }
    await category.destroy({ transaction });
    await audit.recordInTransaction(
      {
        actorId: adminId,
        eventType: audit.EVENTS.CATEGORY_DELETED,
        entityType: 'category',
        entityId: id,
        ip,
        details: { name: category.name },
      },
      transaction
    );
  });
}

module.exports = { createCategory, renameCategory, deleteCategory };
