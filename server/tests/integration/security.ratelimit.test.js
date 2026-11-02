// SC#6: rate limits. Each test uses its own client IP (via the proxy header) so counts
// from one test never leak into another.
process.env.RATE_LIMITS_ENABLED = 'true';
process.env.TRUST_PROXY = '1';

const express = require('express');
const request = require('supertest');
const app = require('../../app');
const { sessionMiddleware } = require('../../config/session');
const requireAuth = require('../../middleware/requireAuth');
const { createWriteLimiters } = require('../../middleware/rateLimiters');
const { errorHandler } = require('../../middleware/errorHandler');
const { User } = require('../../models');
const { resetDb, closeAll, createUser, validRegistration } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const from = (ip) => ({
  login: (body) => request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send(body),
  register: (body) => request(app).post('/api/auth/register').set('X-Forwarded-For', ip).send(body),
});
const wrong = { email: 'nobody@example.com', password: 'WrongPass1' };

describe('login limit: 20 failed attempts per 15 minutes per IP', () => {
  test('the 21st failed attempt from one address is refused, with Retry-After and the standard error shape', async () => {
    const client = from('198.51.100.1');
    for (let i = 0; i < 20; i += 1) expect((await client.login(wrong)).status).toBe(401);

    const blocked = await client.login(wrong);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(blocked.body.error.message).toMatch(/Too many failed login attempts from this network/);
    expect(blocked.body.error.requestId).toBeTruthy();
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
  });

  test('a different address is not affected', async () => {
    for (let i = 0; i < 21; i += 1) await from('198.51.100.2').login(wrong);
    expect((await from('198.51.100.3').login(wrong)).status).toBe(401);
  });

  test('while an address is blocked, even a correct password is refused (so it cannot be used to guess)', async () => {
    const { user, password } = await createUser();
    for (let i = 0; i < 20; i += 1) await from('198.51.100.4').login(wrong);
    expect((await from('198.51.100.4').login({ email: user.email, password })).status).toBe(429);
    expect((await from('198.51.100.5').login({ email: user.email, password })).status).toBe(200);
  });

  test('successful logins are not counted, so students on a shared campus address are not locked out', async () => {
    const { user, password } = await createUser();
    const client = from('198.51.100.6');
    for (let i = 0; i < 30; i += 1) {
      expect((await client.login({ email: user.email, password })).status).toBe(200);
    }
    expect((await client.login(wrong)).status).toBe(401);
  });

  test('failures mixed with successes still add up', async () => {
    const { user, password } = await createUser();
    const client = from('198.51.100.7');
    for (let i = 0; i < 20; i += 1) {
      await client.login(i % 4 === 0 ? { email: user.email, password } : wrong);
    }
    // 15 failures so far; 5 more reach the limit
    for (let i = 0; i < 5; i += 1) await client.login(wrong);
    expect((await client.login(wrong)).status).toBe(429);
  });
});

describe('registration limit: 20 attempts per hour per IP', () => {
  test('every attempt counts, including rejected ones, so probing for registered emails is slowed too', async () => {
    const client = from('198.51.100.10');
    for (let i = 0; i < 20; i += 1) expect((await client.register({})).status).toBe(400);

    const blocked = await client.register(validRegistration());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.body.error.message).toMatch(/Too many sign-up attempts/);
    expect(await User.count()).toBe(0); // the valid request was refused before doing anything
  });

  test('a bot cannot create more than 20 accounts an hour from one address', async () => {
    const client = from('198.51.100.11');
    let created = 0;
    for (let i = 0; i < 30; i += 1) {
      const res = await client.register(
        validRegistration({ email: `bot${i}@example.com`, username: `bot_${i}` })
      );
      if (res.status === 201) created += 1;
    }
    expect(created).toBe(20);
    expect(await User.count()).toBe(20);
  });

  test('other addresses can still register', async () => {
    for (let i = 0; i < 21; i += 1) await from('198.51.100.12').register({});
    expect((await from('198.51.100.13').register(validRegistration())).status).toBe(201);
  });
});

describe('write limiters for review and report endpoints (per account AND per IP)', () => {
  // Throwaway routes with small limits, built with the same factory the real ones use.
  // Every test gets fresh limiters: the database is reset between tests (so user ids repeat),
  // but a limiter's counts live in memory.
  function makeApp() {
    const testApp = express();
    testApp.set('trust proxy', 1);
    testApp.use(express.json());
    testApp.use(sessionMiddleware);
    testApp.use('/api/auth', require('../../routes/authRoutes'));
    const message = 'You are posting too quickly. Please wait a while before trying again.';
    const perIp = createWriteLimiters({ windowMs: 60000, perAccount: 1000, perIp: 5, message });
    const perAccount = createWriteLimiters({
      windowMs: 60000,
      perAccount: 3,
      perIp: 1000,
      message,
    });
    testApp.post('/t/per-ip', requireAuth, ...perIp, (req, res) => res.json({ ok: true }));
    testApp.post('/t/per-account', requireAuth, ...perAccount, (req, res) =>
      res.json({ ok: true })
    );
    testApp.use(errorHandler);
    return testApp;
  }

  async function loggedIn(testApp, ip, overrides) {
    const account = await createUser(overrides);
    const agent = request.agent(testApp);
    await agent
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: account.user.email, password: account.password });
    return (path, forIp = ip) => agent.post(path).set('X-Forwarded-For', forIp);
  }

  test('one account is limited without affecting other accounts on the same network', async () => {
    const testApp = makeApp();
    const alice = await loggedIn(testApp, '198.51.100.20', {
      email: 'alice@example.com',
      username: 'alice',
    });
    const bob = await loggedIn(testApp, '198.51.100.20', {
      email: 'bob@example.com',
      username: 'bob',
    });

    for (let i = 0; i < 3; i += 1) expect((await alice('/t/per-account')).status).toBe(200);
    const blocked = await alice('/t/per-account');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.body.error.message).toMatch(/too quickly/i);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    expect((await bob('/t/per-account')).status).toBe(200); // same IP, different account
  });

  test('an account is limited even when it switches IP addresses', async () => {
    const testApp = makeApp();
    const roamer = await loggedIn(testApp, '198.51.100.30', {
      email: 'roamer@example.com',
      username: 'roamer',
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await roamer('/t/per-account', `198.51.100.${40 + i}`)).status).toBe(200);
    }
    expect((await roamer('/t/per-account', '198.51.100.99')).status).toBe(429);
  });

  test('an IP address is limited across all accounts using it', async () => {
    const testApp = makeApp();
    const alice = await loggedIn(testApp, '198.51.100.50', {
      email: 'alice@example.com',
      username: 'alice',
    });
    const bob = await loggedIn(testApp, '198.51.100.50', {
      email: 'bob@example.com',
      username: 'bob',
    });
    for (let i = 0; i < 3; i += 1) await alice('/t/per-ip');
    for (let i = 0; i < 2; i += 1) await bob('/t/per-ip');
    expect((await alice('/t/per-ip')).status).toBe(429);
    expect((await bob('/t/per-ip')).status).toBe(429);
  });

  test('the real review and report limiters exist and use the documented limits', () => {
    const { reviewWriteLimiters, reportWriteLimiters } = require('../../middleware/rateLimiters');
    expect(reviewWriteLimiters).toHaveLength(2);
    expect(reportWriteLimiters).toHaveLength(2);
  });
});
