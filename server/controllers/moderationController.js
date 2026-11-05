'use strict';
// Administrator dashboard and review moderation (FR#40-FR#44).
const moderationService = require('../services/moderationService');
const { MODERATION_ACTION } = require('../constants/statuses');

async function getDashboard() {
  return { data: { dashboard: await moderationService.getDashboard() } };
}

async function getQueue({ query }) {
  return { data: await moderationService.listQueue(query) };
}

const decision = (action) =>
  async function decide({ adminId, id, body }) {
    const review = await moderationService.decide(adminId, id, action, body.reason);
    return { data: { review } };
  };

module.exports = {
  getDashboard,
  getQueue,
  approve: decision(MODERATION_ACTION.APPROVE),
  flag: decision(MODERATION_ACTION.FLAG),
  remove: decision(MODERATION_ACTION.REMOVE),
};
