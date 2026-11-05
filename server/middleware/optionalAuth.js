'use strict';
// For pages guests may view (FR#9) that look slightly different for a logged-in person,
// for example marking "your" review. Sets req.user when there is a valid session and null
// otherwise; it never rejects the request.
const { getSessionUser } = require('../services/sessionService');

async function optionalAuth(req, res, next) {
  req.user = (await getSessionUser(req, res)) || null;
  next();
}

module.exports = optionalAuth;
