'use strict';
// Reporting a review (FR#31).
const reportService = require('../services/reportService');

// The reasons for the report form's menu.
async function listReasons() {
  return { data: { reasons: reportService.listReasons() } };
}

async function createReport({ userId, id, body }) {
  return { statusCode: 201, data: { report: await reportService.createReport(userId, id, body) } };
}

module.exports = { listReasons, createReport };
