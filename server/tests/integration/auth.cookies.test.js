// Production-style cookie settings: Secure cookies behind an HTTPS-terminating proxy.
process.env.COOKIE_SECURE = 'true';
process.env.COOKIE_SAMESITE = 'strict';
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const app = require('../../app');
const { resetDb, closeAll, validRegistration, getSetCookie } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

describe('Secure cookies (SC#1, SC#5)', () => {
  test('over HTTPS (as reported by the proxy) the cookie is Secure, HttpOnly and SameSite=Strict', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send(validRegistration());
    expect(res.status).toBe(201);
    const cookie = getSetCookie(res);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  test('over plain HTTP no Secure cookie is ever sent (so it cannot leak over an unencrypted link)', async () => {
    const res = await request(app).post('/api/auth/register').send(validRegistration());
    expect(getSetCookie(res)).toBeUndefined();
  });

  test('logout clears the cookie with the same Secure/SameSite attributes', async () => {
    const agent = request.agent(app);
    await agent
      .post('/api/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send(validRegistration());
    const res = await agent.post('/api/auth/logout').set('X-Forwarded-Proto', 'https');
    const cleared = getSetCookie(res);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/; Secure/);
    expect(cleared).toMatch(/SameSite=Strict/);
  });

  test('req.ip comes from the proxy header, for the audit log (AL#3)', async () => {
    await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', '203.0.113.50')
      .send(validRegistration());
    const { sequelize } = require('./helpers');
    const [rows] = await sequelize.query('SELECT host(ip_address) AS ip FROM audit_log');
    expect(rows[0].ip).toBe('203.0.113.50');
  });
});
