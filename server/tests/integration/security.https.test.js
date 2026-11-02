// SC#1: plain HTTP is redirected to HTTPS when FORCE_HTTPS is on (the production default).
process.env.FORCE_HTTPS = 'true';
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const app = require('../../app');
const { resetDb, closeAll, createUser, sequelize } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

describe('HTTPS enforcement', () => {
  test('a plain-HTTP page request is redirected to the same address over HTTPS', async () => {
    const res = await request(app).get('/api/auth/me?x=1').set('Host', 'cubcritics.example');
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe('https://cubcritics.example/api/auth/me?x=1');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('HEAD requests are redirected too', async () => {
    expect((await request(app).head('/api/auth/me').set('Host', 'cubcritics.example')).status).toBe(
      308
    );
  });

  test('requests the proxy says arrived over HTTPS are served normally', async () => {
    const res = await request(app).get('/api/auth/me').set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
  });

  test('a password sent over plain HTTP is refused unprocessed, not redirected', async () => {
    const { user, password } = await createUser();
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HTTPS_REQUIRED');
    expect((await sequelize.query('SELECT 1 FROM sessions'))[0]).toHaveLength(0);
    expect((await sequelize.query('SELECT 1 FROM audit_log'))[0]).toHaveLength(0);
  });

  test('the health check works over plain HTTP, because hosting platforms probe it that way', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  test('a malformed Host header is never turned into a redirect', async () => {
    for (const host of ['evil.example/../x', 'a b', 'x@evil.example']) {
      const res = await request(app).get('/api/auth/me').set('Host', host);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_HOST');
      expect(res.headers.location).toBeUndefined();
    }
  });
});
