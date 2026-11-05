'use strict';
// Achievement badges (FR#16, FR#58). A badge is awarded when a student's number of publicly
// visible reviews reaches its threshold (1, 5, 10, 25 as seeded; names and numbers are rows in
// the achievements table, so TBD-4 is a data change). Badges, once earned, are kept.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');

// Awards every badge the student now qualifies for and does not yet have. Returns the ones
// newly earned, so the response to "post a review" can announce them.
async function awardBadges(userId, { transaction } = {}) {
  const rows = await sequelize.query(
    [
      'WITH visible AS (SELECT COUNT(*)::int AS n FROM reviews',
      "WHERE user_id = $userId AND status IN ('published', 'reported')),",
      'earned AS (INSERT INTO user_achievements (user_id, achievement_id)',
      'SELECT $userId, a.id FROM achievements a, visible WHERE a.review_threshold <= visible.n',
      'ON CONFLICT DO NOTHING RETURNING achievement_id, earned_at)',
      'SELECT a.id, a.name, a.review_threshold, e.earned_at FROM earned e',
      'JOIN achievements a ON a.id = e.achievement_id ORDER BY a.review_threshold',
    ].join(' '),
    { bind: { userId }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map(serializeAchievement);
}

function serializeAchievement(row) {
  return {
    id: row.id,
    name: row.name,
    reviewThreshold: row.review_threshold,
    earnedAt: row.earned_at,
  };
}

// A student's earned badges, lowest threshold first.
async function listForUser(userId) {
  const rows = await sequelize.query(
    [
      'SELECT a.id, a.name, a.review_threshold, ua.earned_at FROM user_achievements ua',
      'JOIN achievements a ON a.id = ua.achievement_id WHERE ua.user_id = $userId',
      'ORDER BY a.review_threshold',
    ].join(' '),
    { bind: { userId }, type: QueryTypes.SELECT }
  );
  return rows.map(serializeAchievement);
}

module.exports = { awardBadges, listForUser };
