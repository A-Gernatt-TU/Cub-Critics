const express = require('express');
const request = require('supertest');
const { createHandler } = require('../../utils/handler');
const { errorHandler } = require('../../middleware/errorHandler');
const { NotFoundError } = require('../../utils/httpExceptions');

function appWith(controller, extract = (req) => ({ id: req.params.id })) {
  const app = express();
  app.get('/t/:id', createHandler(extract, controller));
  app.use(errorHandler);
  return app;
}

describe('createHandler', () => {
  test('passes extracted input to the controller and sends data as JSON (200)', async () => {
    const controller = jest.fn(async ({ id }) => ({ data: { id } }));
    const res = await request(appWith(controller)).get('/t/42');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '42' });
    expect(controller).toHaveBeenCalledWith({ id: '42' }, expect.anything());
  });

  test('uses the controller statusCode', async () => {
    const res = await request(appWith(async () => ({ statusCode: 201, data: { ok: true } }))).get(
      '/t/1'
    );
    expect(res.status).toBe(201);
  });

  test('returns 204 when the controller returns nothing', async () => {
    const res = await request(appWith(async () => undefined)).get('/t/1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  test('sets headers and cookies, and clears cookies', async () => {
    const controller = async () => ({
      data: {},
      headers: { 'X-Thing': 'yes' },
      cookies: [{ name: 'a', value: 'b', options: { httpOnly: true } }],
      clearCookies: [{ name: 'old' }],
    });
    const res = await request(appWith(controller)).get('/t/1');
    expect(res.headers['x-thing']).toBe('yes');
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/a=b.*HttpOnly/);
    expect(cookies).toMatch(/old=;/);
  });

  test('errors thrown by the controller reach the error handler', async () => {
    const res = await request(
      appWith(async () => {
        throw new NotFoundError('Venue not found');
      })
    ).get('/t/1');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Venue not found' });
  });

  test('errors thrown while extracting input reach the error handler', async () => {
    const res = await request(
      appWith(
        async () => ({}),
        () => {
          throw new Error('boom');
        }
      )
    ).get('/t/1');
    expect(res.status).toBe(500);
  });
});
