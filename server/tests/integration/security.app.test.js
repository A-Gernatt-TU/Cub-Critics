// App-wide protections: cross-site request blocking, bad characters, headers (SC#1, SC#4, SC#5).
const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { resetDb, closeAll, createUser, validRegistration, sequelize } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const sessionCount = async () => (await sequelize.query('SELECT 1 FROM sessions'))[0].length;

describe('Cross-site request blocking', () => {
  test('a state-changing request from another site is refused, even with a valid session cookie', async () => {
    const agent = request.agent(app);
    const account = await createUser();
    await agent
      .post('/api/auth/login')
      .send({ email: account.user.email, password: account.password });
    expect(await sessionCount()).toBe(1);

    const forged = await agent.post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(await sessionCount()).toBe(1); // the forged logout did nothing
    expect((await agent.get('/api/auth/me')).body.user).not.toBeNull();
  });

  test('a forged login or registration is refused before any work is done', async () => {
    const account = await createUser();
    const login = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: account.user.email, password: account.password });
    expect(login.status).toBe(403);
    expect(await sessionCount()).toBe(0);

    const register = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'https://evil.example')
      .send(validRegistration());
    expect(register.status).toBe(403);
    expect(await User.count()).toBe(1);
    const [rows] = await sequelize.query('SELECT 1 FROM audit_log');
    expect(rows).toHaveLength(0);
  });

  test.each(['PUT', 'PATCH', 'DELETE', 'POST'])(
    '%s from another site is refused (before routing)',
    async (method) => {
      const send = request(app)[method.toLowerCase()].bind(request(app));
      const res = await send('/api/anything').set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
    }
  );

  test('the literal "null" origin (sandboxed pages) is refused', async () => {
    const res = await request(app).post('/api/auth/logout').set('Origin', 'null');
    expect(res.status).toBe(403);
  });

  test('look-alike origins are refused', async () => {
    for (const origin of [
      'http://localhost:5173.evil.example',
      'http://localhost:5174',
      'https://localhost:5173',
      'http://localhost.evil.example:5173',
      'http://localhost:5173/',
    ]) {
      const res = await request(app).post('/api/auth/logout').set('Origin', origin);
      expect(res.status).toBe(403);
    }
  });

  test('our own frontend origin works', async () => {
    const account = await createUser();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: account.user.email, password: account.password });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('the server’s own origin works (frontend served from the same host)', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Host', 'api.example.test')
      .set('Origin', 'http://api.example.test');
    expect(res.status).toBe(204);
  });

  test('requests with no Origin (curl, Postman) work', async () => {
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
  });

  test('with no Origin, a browser marking the request cross-site is refused; other markers pass', async () => {
    expect(
      (await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site')).status
    ).toBe(403);
    for (const mode of ['same-origin', 'same-site', 'none']) {
      expect((await request(app).post('/api/auth/logout').set('Sec-Fetch-Site', mode)).status).toBe(
        204
      );
    }
  });

  test('reading data is not blocked, but another site gets no CORS permission to read it', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Bad characters (SC#4)', () => {
  const post = (body) => request(app).post('/api/auth/login').send(body);

  test('a NUL byte anywhere in a JSON body is refused with a clear error', async () => {
    for (const body of [
      { email: 'a@example.com', password: 'abc\u0000def' },
      { email: 'a\u0000@example.com', password: 'x' },
      { nested: { deep: ['ok', 'bad\u0000'] } },
      { 'bad\u0000key': 'x' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  test('registration with a NUL byte in the password creates nothing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validRegistration({ password: 'Passw0rd\u0000hidden' }));
    expect(res.status).toBe(400);
    expect(await User.count()).toBe(0);
  });

  test('an encoded NUL in the URL is refused', async () => {
    for (const url of ['/api/auth/me?x=%00', '/api/auth/%00me', '/api/health%00.php']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
  });

  test('absurdly deep JSON is refused, normal nesting is fine', async () => {
    let deep = { v: 1 };
    for (let i = 0; i < 30; i += 1) deep = { n: deep };
    expect((await post(deep)).status).toBe(400);
    expect((await post({ a: { b: { c: [1, 2, { d: 3 }] } } })).status).toBe(400); // fine input, fails validation only
    expect((await post({ a: { b: { c: [1] } } })).body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Response headers', () => {
  test('an API that never serves pages tells browsers not to load or frame anything from it', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'"
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('every API response, including errors, is marked not-cacheable', async () => {
    for (const url of ['/api/health', '/api/auth/me', '/api/nope']) {
      expect((await request(app).get(url)).headers['cache-control']).toBe('no-store');
    }
    expect((await request(app).post('/api/auth/login').send({})).headers['cache-control']).toBe(
      'no-store'
    );
  });

  test('error responses are JSON and carry a request id', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
