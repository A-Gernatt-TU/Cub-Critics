// requireAuth / requireRole (SC#3, SC#10, FR#8, FR#10) on throwaway routes.
const express = require('express');
const request = require('supertest');
const { sessionMiddleware } = require('../../config/session');
const requireAuth = require('../../middleware/requireAuth');
const requireRole = require('../../middleware/requireRole');
const { errorHandler } = require('../../middleware/errorHandler');
const { ROLE } = require('../../constants/roles');
const { User } = require('../../models');
const { resetDb, closeAll, createUser, sequelize } = require('./helpers');

const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use('/api/auth', require('../../routes/authRoutes'));
app.get('/t/member', requireAuth, (req, res) => res.json({ id: req.user.id, role: req.user.role }));
app.get('/t/admin', requireRole(ROLE.ADMINISTRATOR), (req, res) => res.json({ ok: true }));
app.get('/t/anyone-logged-in', requireRole(ROLE.STUDENT, ROLE.ADMINISTRATOR), (req, res) =>
  res.json({ ok: true })
);
app.use(errorHandler);

beforeEach(resetDb);
afterAll(closeAll);

async function agentFor(overrides) {
  const account = await createUser(overrides);
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .send({ email: account.user.email, password: account.password });
  return { agent, ...account };
}

describe('requireAuth', () => {
  test('guests get 401', async () => {
    const res = await request(app).get('/t/member');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  });

  test('logged-in people pass, and req.user is the real account', async () => {
    const { agent, user } = await agentFor();
    const res = await agent.get('/t/member');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: user.id, role: 'student' });
  });

  test('an expired session gets 401', async () => {
    const { agent } = await agentFor();
    await sequelize.query(`UPDATE sessions SET expire = NOW() - INTERVAL '1 second'`);
    expect((await agent.get('/t/member')).status).toBe(401);
  });

  test('a deactivated account gets 401 immediately, and its session is removed', async () => {
    const { agent, user } = await agentFor();
    await User.update({ status: 'deactivated' }, { where: { id: user.id } });
    expect((await agent.get('/t/member')).status).toBe(401);
    expect((await sequelize.query('SELECT 1 FROM sessions'))[0]).toHaveLength(0);
  });

  test('a forged cookie gets 401', async () => {
    const res = await request(app).get('/t/member').set('Cookie', 'cubcritics.sid=s%3Aforged.sig');
    expect(res.status).toBe(401);
  });
});

describe('requireRole', () => {
  test('guests get 401 (not logged in), not 403', async () => {
    expect((await request(app).get('/t/admin')).status).toBe(401);
  });

  test('a student is denied administrator routes with "Access denied" (FR#10)', async () => {
    const { agent } = await agentFor({ role: 'student' });
    const res = await agent.get('/t/admin');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });

  test('an administrator passes administrator routes', async () => {
    const { agent } = await agentFor({ role: 'administrator' });
    expect((await agent.get('/t/admin')).status).toBe(200);
  });

  test('both roles pass a route that allows both', async () => {
    for (const role of ['student', 'administrator']) {
      const { agent } = await agentFor({ role, email: `${role}@example.com`, username: role });
      expect((await agent.get('/t/anyone-logged-in')).status).toBe(200);
    }
  });

  test('permissions follow the database, not the session: a demoted admin loses access at once', async () => {
    const { agent, user } = await agentFor({ role: 'administrator' });
    expect((await agent.get('/t/admin')).status).toBe(200);
    await User.update({ role: 'student' }, { where: { id: user.id } });
    expect((await agent.get('/t/admin')).status).toBe(403);
  });

  test('a promoted student gains access at once', async () => {
    const { agent, user } = await agentFor({ role: 'student' });
    expect((await agent.get('/t/admin')).status).toBe(403);
    await User.update({ role: 'administrator' }, { where: { id: user.id } });
    expect((await agent.get('/t/admin')).status).toBe(200);
  });

  test('claiming a role in the request changes nothing', async () => {
    const { agent } = await agentFor({ role: 'student' });
    const res = await agent.get('/t/admin?role=administrator').set('X-Role', 'administrator');
    expect(res.status).toBe(403);
  });
});
