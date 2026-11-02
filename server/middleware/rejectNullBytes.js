'use strict';
/* eslint-disable no-control-regex -- matching control characters is the purpose of this file */
// Rejects any request containing a NUL character (\u0000) in the URL, query string or JSON
// body. PostgreSQL cannot store NUL in text, so it would surface later as a confusing
// server error; and NUL bytes are a classic trick for slipping past validation (SC#4).
// Also rejects absurdly deep JSON, which has no legitimate use here.
const { BadRequestError } = require('../utils/httpExceptions');

const MAX_DEPTH = 10;

function hasProblem(value, depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((item) => hasProblem(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, item]) => key.includes('\u0000') || hasProblem(item, depth + 1)
    );
  }
  return false;
}

function rejectNullBytes(req, res, next) {
  if (/%00|\u0000/i.test(req.originalUrl) || hasProblem(req.body)) {
    return next(
      new BadRequestError('Request contains invalid characters', { code: 'INVALID_INPUT' })
    );
  }
  return next();
}

module.exports = rejectNullBytes;
