'use strict';
// Blocks forged cross-site requests (CSRF) as a second layer behind the SameSite cookie.
//
// Browsers always send an Origin header on cross-site POST/PUT/PATCH/DELETE requests, and
// a web page cannot change it. So any state-changing request whose Origin is not our own
// frontend is refused, even if it carries a valid session cookie.
//  - Allowed: origins listed in ALLOWED_ORIGINS, and the server's own origin.
//  - No Origin header at all: curl, Postman and server-to-server calls, which cannot be
//    CSRF'd because they do not carry a victim's browser cookies. Browsers that omit
//    Origin still send Sec-Fetch-Site, which is checked instead.
const config = require('../config/env');
const { ForbiddenError } = require('../utils/httpExceptions');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const refuse = () =>
  new ForbiddenError('This request came from a site that is not allowed', {
    code: 'ORIGIN_NOT_ALLOWED',
  });

function originCheck(req, res, next) {
  if (!STATE_CHANGING.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin) {
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin === ownOrigin || config.allowedOrigins.includes(origin)) return next();
    return next(refuse()); // includes the literal "null" origin of sandboxed pages
  }

  if (req.get('sec-fetch-site') === 'cross-site') return next(refuse());
  return next();
}

module.exports = originCheck;
