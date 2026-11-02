'use strict';
// Blocks guests from an endpoint (SC#3, SC#12, SC#13). Use it on any route that needs a
// logged-in person; on success `req.user` is the current account.
//
//   router.post('/venues/:id/reviews', requireAuth, ...)
//
// The account is re-read from the database on every request, so a deactivated account
// or a changed role takes effect immediately. A missing, expired or invalid session is
// answered with 401.
const { getSessionUser } = require('../services/sessionService');
const { UnauthorizedError } = require('../utils/httpExceptions');

async function requireAuth(req, res, next) {
  const user = await getSessionUser(req, res);
  if (!user) throw new UnauthorizedError();
  req.user = user;
  next();
}

module.exports = requireAuth;
