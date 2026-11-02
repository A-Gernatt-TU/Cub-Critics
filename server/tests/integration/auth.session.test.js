const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { destroyAllSessionsForUser } = require('../../services/sessionService');
const {
  resetDb,
  closeAll,
  createUser,
  getSetCookie,
  validRegistration,
  sequelize,
} = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const loginAs = async (agent, { user, password }) => {
  const res = await agent.post('/api/auth/login').send({ email: user.email, password });
  expect(res.status).toBe(200);
  return res;
};
const me = (agent) => agent.get('/api/auth/me');
const secondsUntilExpiry = async () => {
  const [rows] = await sequelize.query(
    `SELECT EXTRACT(EPOCH FROM (expire - NOW())) AS s FROM sessions`
  );
  return Number(rows[0].s);
};
const sessionCount = async () => (await sequelize.query('SELECT 1 FROM sessions'))[0].length;

describe('GET /api/auth/me', () => {
  test('guests get { user: null }, no error, and no cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
    expect(getSetCookie(res)).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await sessionCount()).toBe(0);
  });

  test('a logged-in person gets their own account, including their email', async () => {
    const agent = request.agent(app);
    const account = await createUser({ email: 'jo@example.com', username: 'jo' });
    await loginAs(agent, account);
    const res = await me(agent);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      username: 'jo',
      email: 'jo@example.com',
      role: 'student',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });
});

describe('POST /api/auth/logout (FR#7)', () => {
  test('ends the session immediately, deletes it, and clears the cookie', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser());
    expect(await sessionCount()).toBe(1);

    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(getSetCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await sessionCount()).toBe(0);
    expect((await me(agent)).body.user).toBeNull();
  });

  test('an old cookie cannot be replayed after logout', async () => {
    const account = await createUser();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: account.user.email, password: account.password });
    const stolen = getSetCookie(login).split(';')[0];

    expect((await request(app).get('/api/auth/me').set('Cookie', stolen)).body.user).not.toBeNull();
    await request(app).post('/api/auth/logout').set('Cookie', stolen);
    expect((await request(app).get('/api/auth/me').set('Cookie', stolen)).body.user).toBeNull();
  });

  test('logging out when not logged in is harmless', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
  });

  test('logging out records an audit entry, and only for real sessions', async () => {
    const agent = request.agent(app);
    const account = await createUser();
    await loginAs(agent, account);
    await agent.post('/api/auth/logout');
    await request(app).post('/api/auth/logout');
    const [rows] = await sequelize.query(
      `SELECT actor_id FROM audit_log WHERE event_type = 'logout'`
    );
    expect(rows).toEqual([{ actor_id: account.user.id }]);
  });

  test('logging out one device leaves the same user’s other device logged in', async () => {
    const account = await createUser();
    const phone = request.agent(app);
    const laptop = request.agent(app);
    await loginAs(phone, account);
    await loginAs(laptop, account);
    await phone.post('/api/auth/logout');
    expect((await me(phone)).body.user).toBeNull();
    expect((await me(laptop)).body.user).not.toBeNull();
  });
});

describe('Idle timeout (SC#12)', () => {
  test('a student session that sat idle past its expiry is gone', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser());
    await sequelize.query(`UPDATE sessions SET expire = NOW() - INTERVAL '1 second'`);
    expect((await me(agent)).body.user).toBeNull();
  });

  test('every request moves a student’s deadline back out to 30 minutes ("rolling")', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser());
    await sequelize.query(`UPDATE sessions SET expire = NOW() + INTERVAL '60 seconds'`);
    expect(await secondsUntilExpiry()).toBeLessThan(65);

    const res = await me(agent);
    expect(res.body.user).not.toBeNull();
    expect(Math.abs((await secondsUntilExpiry()) - 1800)).toBeLessThan(10);
    const cookieExpires = Date.parse(getSetCookie(res).match(/Expires=([^;]+)/)[1]);
    expect(Math.abs(cookieExpires - (Date.now() + 1800 * 1000))).toBeLessThan(10000);
  });

  test('administrators keep the shorter 15-minute window, also after being refreshed', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser({ role: 'administrator' }));
    expect(Math.abs((await secondsUntilExpiry()) - 900)).toBeLessThan(10);

    await sequelize.query(`UPDATE sessions SET expire = NOW() + INTERVAL '60 seconds'`);
    await me(agent);
    expect(Math.abs((await secondsUntilExpiry()) - 900)).toBeLessThan(10);
  });

  test('an administrator expired at 15 idle minutes is logged out', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser({ role: 'administrator' }));
    await sequelize.query(`UPDATE sessions SET expire = NOW() - INTERVAL '1 minute'`);
    expect((await me(agent)).body.user).toBeNull();
  });

  test('a fresh login is required after expiry (the old cookie does not come back to life)', async () => {
    const agent = request.agent(app);
    const account = await createUser();
    await loginAs(agent, account);
    await sequelize.query(`UPDATE sessions SET expire = NOW() - INTERVAL '1 second'`);
    expect((await me(agent)).body.user).toBeNull();
    await loginAs(agent, account);
    expect((await me(agent)).body.user).not.toBeNull();
  });
});

describe('Invalid cookies (SC#13)', () => {
  test.each([
    ['forged signature', 'cubcritics.sid=s%3Aabc123.notarealsignature'],
    ['unsigned id', 'cubcritics.sid=abc123'],
    ['empty', 'cubcritics.sid='],
    ['garbage', 'cubcritics.sid=%E0%A4%A'],
  ])('%s is treated as a guest, with no error', async (_label, cookie) => {
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });

  test('a session whose data was tampered with in the database does not crash anything', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createUser());
    await sequelize.query(
      `UPDATE sessions SET sess = '{"cookie":{"originalMaxAge":1000},"userId":999999}'`
    );
    const res = await me(agent);
    expect(res.status).toBe(200);
    expect(res.body.user).toBeNull();
  });
});

describe('Revoking sessions (SC#13)', () => {
  test('a deactivated account is logged out on its very next request', async () => {
    const agent = request.agent(app);
    const account = await createUser();
    await loginAs(agent, account);
    await User.update({ status: 'deactivated' }, { where: { id: account.user.id } });

    const res = await me(agent);
    expect(res.body.user).toBeNull();
    expect(getSetCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await sessionCount()).toBe(0);
  });

  test('destroyAllSessionsForUser logs a user out of every device, and only that user', async () => {
    const target = await createUser({ email: 't@example.com', username: 'target' });
    const bystander = await createUser({ email: 'b@example.com', username: 'bystander' });
    const phone = request.agent(app);
    const laptop = request.agent(app);
    const other = request.agent(app);
    await loginAs(phone, target);
    await loginAs(laptop, target);
    await loginAs(other, bystander);

    await destroyAllSessionsForUser(target.user.id);

    expect((await me(phone)).body.user).toBeNull();
    expect((await me(laptop)).body.user).toBeNull();
    expect((await me(other)).body.user.username).toBe('bystander');
  });

  test('registration sessions can be revoked the same way', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/register').send(validRegistration());
    await destroyAllSessionsForUser(res.body.user.id);
    expect((await me(agent)).body.user).toBeNull();
  });

  test('a role change takes effect immediately, including the idle timeout', async () => {
    const agent = request.agent(app);
    const account = await createUser();
    await loginAs(agent, account);
    expect(Math.abs((await secondsUntilExpiry()) - 1800)).toBeLessThan(10);

    await User.update({ role: 'administrator' }, { where: { id: account.user.id } });
    const res = await me(agent);
    expect(res.body.user.role).toBe('administrator');
    expect(Math.abs((await secondsUntilExpiry()) - 900)).toBeLessThan(10);
  });

  test('deleting a user removes their sessions', async () => {
    const account = await createUser();
    await loginAs(request.agent(app), account);
    await sequelize.query('DELETE FROM users WHERE id = :id', {
      replacements: { id: account.user.id },
    });
    expect(await sessionCount()).toBe(0);
  });
});
