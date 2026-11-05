'use strict';
// Rate limits (SC#6). Counts live in server memory, which is right for one server
// instance (typical for low-cost hosting). If the app is ever run as several copies,
// switch to a shared store, or each copy would count separately.
//
// Behind a hosting proxy, TRUST_PROXY must be set; otherwise every visitor looks like the
// proxy's single address and they would all share one limit.
//
// Turn off in development/tests with RATE_LIMITS_ENABLED=false (refused in production).
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config/env');
const { RATE_LIMITS } = require('../constants/limits');
const { TooManyRequestsError } = require('../utils/httpExceptions');

const passThrough = (req, res, next) => next();

function buildLimiter({
  windowMs,
  limit,
  message = 'Too many requests. Please slow down and try again shortly.',
  keyGenerator,
  skipSuccessfulRequests = false,
  skip,
}) {
  if (!config.rateLimitsEnabled) return passThrough;

  const options = {
    windowMs,
    limit,
    standardHeaders: 'draft-7', // RateLimit and RateLimit-Policy headers
    legacyHeaders: false,
    skipSuccessfulRequests,
    // Same JSON error shape as everything else, plus a Retry-After header.
    handler: (req, res, next) => {
      const resetTime = req.rateLimit && req.rateLimit.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      next(new TooManyRequestsError(message, { retryAfterSeconds }));
    },
  };
  if (keyGenerator) options.keyGenerator = keyGenerator;
  if (skip) options.skip = skip;
  return rateLimit(options);
}

// Every /api request, per IP. Exempt: the health check (so monitoring never trips it) and
// image downloads (cheap, cached by browsers, and a page shows many at once).
const globalLimiter = buildLimiter({
  windowMs: 60 * 1000,
  limit: config.rateLimitGlobalPerMinute,
  skip: (req) => {
    const path = req.originalUrl.split('?')[0];
    return path === '/api/health' || path.startsWith('/api/files/');
  },
});

// Failed logins only: 20 per 15 minutes per IP (successful logins are not counted).
const loginLimiter = buildLimiter({
  ...RATE_LIMITS.login,
  skipSuccessfulRequests: true,
  message: 'Too many failed login attempts from this network. Please try again later.',
});

// Every registration attempt, per IP.
const registerLimiter = buildLimiter({
  ...RATE_LIMITS.register,
  message: 'Too many sign-up attempts from this network. Please try again later.',
});

// Limits for endpoints that write content: one limit per IP and one per logged-in account.
// Use AFTER requireAuth so the account is known:
//   router.post('/', requireAuth, ...reviewWriteLimiters, handler)
const accountKey = (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip));

function createWriteLimiters({ windowMs, perAccount, perIp, message }) {
  return [
    buildLimiter({ windowMs, limit: perIp, message }),
    buildLimiter({ windowMs, limit: perAccount, message, keyGenerator: accountKey }),
  ];
}

const reviewWriteLimiters = createWriteLimiters({
  ...RATE_LIMITS.review,
  message: 'You are posting too quickly. Please wait a while before trying again.',
});
const reportWriteLimiters = createWriteLimiters({
  ...RATE_LIMITS.report,
  message: 'You are sending reports too quickly. Please wait a while before trying again.',
});

const uploadLimiters = createWriteLimiters({
  ...RATE_LIMITS.upload,
  message: 'You are uploading too many images. Please wait a while before trying again.',
});

module.exports = {
  uploadLimiters,
  buildLimiter,
  createWriteLimiters,
  globalLimiter,
  loginLimiter,
  registerLimiter,
  reviewWriteLimiters,
  reportWriteLimiters,
};
