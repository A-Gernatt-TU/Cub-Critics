// SC#6: the per-IP limit on the whole API, set tiny here so it is quick to reach.
process.env.RATE_LIMITS_ENABLED = 'true';
process.env.RATE_LIMIT_GLOBAL_PER_MINUTE = '5';
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const app = require('../../app');
const { closeAll } = require('./helpers');

afterAll(closeAll);

const get = (path, ip) => request(app).get(path).set('X-Forwarded-For', ip);

describe('global limit per IP', () => {
  test('the 6th request in a minute is refused with the standard error shape', async () => {
    for (let i = 0; i < 5; i += 1)
      expect((await get('/api/auth/me', '198.51.100.60')).status).toBe(200);
    const blocked = await get('/api/auth/me', '198.51.100.60');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  test('other addresses are unaffected', async () => {
    for (let i = 0; i < 8; i += 1) await get('/api/nope', '198.51.100.61');
    expect((await get('/api/auth/me', '198.51.100.62')).status).toBe(200);
  });

  test('the health check is never limited (monitoring must keep working)', async () => {
    for (let i = 0; i < 15; i += 1)
      expect((await get('/api/health', '198.51.100.63')).status).toBe(200);
  });

  test('image downloads are not counted (a page shows many at once)', async () => {
    const image = '/api/files/venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg';
    for (let i = 0; i < 15; i += 1) expect((await get(image, '198.51.100.64')).status).toBe(404);
    expect((await get('/api/auth/me', '198.51.100.64')).status).toBe(200); // image traffic used none of the budget
  });

  test('the client address comes from the proxy, not from whatever the visitor claims', async () => {
    // Only the LAST address added by our proxy is trusted; extra ones the client prepends are ignored.
    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/api/auth/me').set('X-Forwarded-For', `10.0.0.${i}, 198.51.100.65`);
    }
    const blocked = await request(app)
      .get('/api/auth/me')
      .set('X-Forwarded-For', '10.9.9.9, 198.51.100.65');
    expect(blocked.status).toBe(429);
  });
});
