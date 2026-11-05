'use strict';
// Administrator category management.
const categoryService = require('../services/categoryService');

async function createCategory({ adminId, body, ip }) {
  return {
    statusCode: 201,
    data: { category: await categoryService.createCategory(adminId, body, ip) },
  };
}

async function renameCategory({ adminId, id, body, ip }) {
  return { data: { category: await categoryService.renameCategory(adminId, id, body, ip) } };
}

async function deleteCategory({ adminId, id, ip }) {
  await categoryService.deleteCategory(adminId, id, ip);
}

module.exports = { createCategory, renameCategory, deleteCategory };
