'use strict';
// Allows only certain roles (FR#8, FR#10, SC#3, SC#10). It includes the login check, so
// it can be used on its own:
//
//   router.get('/admin/queue', requireRole(ROLE.ADMINISTRATOR), ...)
//
// Guests get 401; logged-in people without the role get 403 "Access denied".
const requireAuth = require('./requireAuth');
const { ForbiddenError } = require('../utils/httpExceptions');

function requireRole(...roles) {
  const checkRole = (req, res, next) => {
    if (!roles.includes(req.user.role)) throw new ForbiddenError();
    next();
  };
  return [requireAuth, checkRole];
}

module.exports = requireRole;
