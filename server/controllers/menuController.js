'use strict';
// Administrator menu management (FR#48-FR#50).
const menuService = require('../services/menuService');

async function createItem({ adminId, venueId, body, ip }) {
  const item = await menuService.createMenuItem(adminId, venueId, body, ip);
  return { statusCode: 201, data: { item } };
}

async function updateItem({ adminId, id, body, ip }) {
  return { data: { item: await menuService.updateMenuItem(adminId, id, body, ip) } };
}

async function deleteItem({ adminId, id, ip }) {
  await menuService.deleteMenuItem(adminId, id, ip);
}

module.exports = { createItem, updateItem, deleteItem };
