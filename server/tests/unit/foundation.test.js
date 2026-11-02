process.env.ALLOWED_ORIGINS = 'http://localhost:5173';

jest.mock('../../models', () => ({ sequelize: { authenticate: jest.fn() } }));

const request = require('supertest');
const { sequelize } = require('../../models');
const app = require('../../app');

describe('GET /api/health', () => {
  test('200 when the database is reachable', async () => {
    sequelize.authenticate.mockResolvedValue();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  test('503 when the database is down, without leaking details', async () => {
    sequelize.authenticate.mockRejectedValue(
      new Error('password authentication failed for user "me"')
    );
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'down' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|authentication/);
  });
});

describe('app-level behavior', () => {
  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/')).status).toBe(404);
  });

  test('malformed JSON returns 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  test('bodies over 100 KB return 413', async () => {
    const res = await request(app)
      .post('/api/health')
      .send({ text: 'a'.repeat(200000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('every response gets a unique X-Request-Id, repeated in error bodies', async () => {
    const a = await request(app).get('/api/nope');
    const b = await request(app).get('/api/nope');
    expect(a.headers['x-request-id']).toBeTruthy();
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    expect(a.body.error.requestId).toBe(a.headers['x-request-id']);
  });

  test('a client-supplied request id is ignored', async () => {
    const res = await request(app).get('/api/nope').set('X-Request-Id', 'attacker-value');
    expect(res.headers['x-request-id']).not.toBe('attacker-value');
  });

  test('security headers are set and x-powered-by is hidden', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  test('allows the configured frontend origin with credentials', async () => {
    const res = await request(app).get('/api/nope').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('does not allow other origins', async () => {
    const res = await request(app).get('/api/nope').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('answers preflight requests for the allowed origin', async () => {
    const res = await request(app)
      .options('/api/anything')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
  });
});
