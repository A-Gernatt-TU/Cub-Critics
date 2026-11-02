'use strict';
// SC#1: plain-HTTP requests are redirected to HTTPS. Only active when FORCE_HTTPS is on
// (the production default). It relies on TRUST_PROXY so the app knows the host's proxy
// received the request over HTTPS (config/env.js refuses settings that would break this).
//  - GET/HEAD: redirected (308).
//  - Anything else over HTTP is refused, because the request, and any password in it,
//    has already travelled unencrypted and must not be processed.
//  - /api/health is exempt: hosting platforms often probe it over internal plain HTTP.
const config = require('../config/env');
const { BadRequestError } = require('../utils/httpExceptions');

const SAFE_HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

function enforceHttps(req, res, next) {
  if (!config.forceHttps || req.secure) return next();
  if (req.originalUrl.split('?')[0] === '/api/health') return next();

  if (req.method === 'GET' || req.method === 'HEAD') {
    const host = req.get('host');
    // Never build a redirect from a malformed Host header.
    if (!host || !SAFE_HOST.test(host)) {
      return next(new BadRequestError('Invalid Host header', { code: 'INVALID_HOST' }));
    }
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  }
  return next(new BadRequestError('HTTPS is required', { code: 'HTTPS_REQUIRED' }));
}

module.exports = enforceHttps;
