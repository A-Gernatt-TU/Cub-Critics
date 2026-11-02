'use strict';
// notFoundHandler + errorHandler: the last two pieces of middleware in app.js.
// Every failure becomes the same JSON shape, and internals (stack traces, SQL, table
// or index names) are never sent to the client.
const {
  ConnectionError,
  TimeoutError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  ValidationError: SequelizeValidationError,
} = require('sequelize');
const logger = require('../utils/logger');
const {
  HttpError,
  BadRequestError,
  ValidationError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
} = require('../utils/httpExceptions');

// Connection problems raised by the `pg` driver itself (the session store uses it
// directly, outside Sequelize). Shown as the friendly 503 (CP#3), not a technical error.
const PG_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08006',
]);

function isDatabaseConnectionError(err) {
  if (PG_CONNECTION_CODES.has(err.code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
    err.message || ''
  );
}

function notFoundHandler(req, res, next) {
  next(new NotFoundError('Resource not found'));
}

// Turns anything thrown into an HttpError, or returns null for "unexpected" (500).
function toHttpError(err) {
  if (err instanceof HttpError) return err;

  // Body parser problems (express.json)
  if (err.type === 'entity.parse.failed') {
    return new BadRequestError('Request body is not valid JSON', { code: 'INVALID_JSON' });
  }
  if (err.type === 'entity.too.large') return new PayloadTooLargeError();

  // Database safety nets. Services should check these cases first and give field-specific
  // messages; these catch anything that slips through (e.g. two requests at the same time).
  if (err instanceof UniqueConstraintError) {
    return new ConflictError('That value is already in use');
  }
  if (err instanceof ForeignKeyConstraintError) {
    return new ConflictError('This item is linked to other records, so that change is not allowed');
  }
  if (err instanceof SequelizeValidationError) {
    return new ValidationError(
      'Please correct the highlighted fields',
      err.errors.map((e) => ({ field: e.path, message: e.message }))
    );
  }
  if (
    err instanceof ConnectionError ||
    err instanceof TimeoutError ||
    isDatabaseConnectionError(err)
  ) {
    return new ServiceUnavailableError();
  }

  // Other 4xx errors raised by Express/body-parser (e.g. unsupported charset).
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && err.expose) {
    return new HttpError(err.status, err.message);
  }
  return null;
}

// Express recognises error handlers by their four parameters; do not remove `next`.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const known = toHttpError(err);
  const statusCode = known ? known.statusCode : 500;

  if (statusCode >= 500) {
    logger.error(
      { err, requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0] },
      'Request failed'
    );
  }

  const body = {
    code: known ? known.code : 'INTERNAL_ERROR',
    message: known ? known.message : 'Something went wrong on our end. Please try again.',
  };
  if (known && known.details !== undefined) body.details = known.details;
  if (req.id) body.requestId = req.id;

  if (known && known.retryAfterSeconds !== undefined) {
    res.set('Retry-After', String(known.retryAfterSeconds));
  }
  return res.status(statusCode).json({ error: body });
}

module.exports = { notFoundHandler, errorHandler };
