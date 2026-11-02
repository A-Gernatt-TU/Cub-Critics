const express = require('express');
const request = require('supertest');
const {
  ConnectionError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  ValidationError: SequelizeValidationError,
  ValidationErrorItem,
} = require('sequelize');
const { errorHandler } = require('../../middleware/errorHandler');
const {
  ForbiddenError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  TooManyRequestsError,
} = require('../../utils/httpExceptions');

// Tiny app whose only route throws (or rejects with) the given error.
function appThatThrows(err, { async: isAsync = false } = {}) {
  const app = express();
  app.get(
    '/boom',
    isAsync
      ? async () => {
          throw err;
        }
      : () => {
          throw err;
        }
  );
  app.use(errorHandler);
  return app;
}
const hit = (err, opts) => request(appThatThrows(err, opts)).get('/boom');

describe('errorHandler', () => {
  test('HttpError subclasses keep their status, code and message', async () => {
    const forbidden = await hit(new ForbiddenError());
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });

    const unauthorized = await hit(new UnauthorizedError());
    expect(unauthorized.status).toBe(401);

    const conflict = await hit(new ConflictError('Already reviewed'));
    expect(conflict.status).toBe(409);
  });

  test('ValidationError carries per-field details', async () => {
    const res = await hit(
      new ValidationError('Fix these', [{ field: 'email', message: 'Already in use' }])
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'email', message: 'Already in use' }]);
  });

  test('TooManyRequestsError sets Retry-After', async () => {
    const res = await hit(new TooManyRequestsError('Locked', { retryAfterSeconds: 900 }));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
  });

  test('rejected promises from async routes are handled (Express 5)', async () => {
    const res = await hit(new ForbiddenError(), { async: true });
    expect(res.status).toBe(403);
  });

  test('database unique violation -> 409 without leaking the constraint name', async () => {
    const res = await hit(
      new UniqueConstraintError({
        parent: { constraint: 'users_email_lower_key', sql: 'INSERT ...' },
      })
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/users_email_lower_key|INSERT/);
  });

  test('database foreign key violation -> 409', async () => {
    const res = await hit(new ForeignKeyConstraintError({ parent: { sql: 'DELETE ...' } }));
    expect(res.status).toBe(409);
  });

  test('Sequelize validation error -> 400 with field details', async () => {
    const item = new ValidationErrorItem(
      'Validation len on bio failed',
      'Validation error',
      'bio',
      'x'
    );
    const res = await hit(new SequelizeValidationError('bad', [item]));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'bio', message: 'Validation len on bio failed' },
    ]);
  });

  test('database connection failure -> 503 with a friendly message (CP#3)', async () => {
    const res = await hit(new ConnectionError(new Error('connect ECONNREFUSED 10.0.0.5:5432')));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  test('raw pg connection errors (e.g. from the session store) -> 503', async () => {
    for (const err of [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
      Object.assign(new Error('terminating connection'), { code: '57P01' }),
    ]) {
      const res = await hit(err);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  test('unexpected errors -> 500 with a generic message and no internals', async () => {
    const res = await hit(new Error('secret db password hunter2 in stack'));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|stack|at Object/);
  });
});
