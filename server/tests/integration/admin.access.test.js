// Every administrator endpoint is closed to guests and students (FR#8, FR#10, SC#3, SC#10, SC#14).
const request = require('supertest');
const app = require('../../app');
const { resetDb, closeAll, loginAs, createVenue } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const ENDPOINTS = [
  ['get', '/api/admin/dashboard'],
  ['get', '/api/admin/moderation/queue'],
  ['post', '/api/admin/reviews/1/approve'],
  ['post', '/api/admin/reviews/1/flag'],
  ['post', '/api/admin/reviews/1/remove'],
  ['get', '/api/admin/venues'],
  ['get', '/api/admin/venues/1'],
  ['post', '/api/admin/venues'],
  ['patch', '/api/admin/venues/1'],
  ['post', '/api/admin/venues/1/deactivate'],
  ['post', '/api/admin/venues/1/reactivate'],
  ['post', '/api/admin/venues/1/menu-items'],
  ['patch', '/api/admin/menu-items/1'],
  ['delete', '/api/admin/menu-items/1'],
  ['post', '/api/admin/venues/1/photos'],
  ['delete', '/api/admin/photos/1'],
  ['post', '/api/admin/categories'],
  ['patch', '/api/admin/categories/1'],
  ['delete', '/api/admin/categories/1'],
  // Even addresses that do not exist must not reveal anything to non-administrators.
  ['get', '/api/admin/anything-else'],
  ['get', '/api/admin'],
  ['post', '/api/admin/venues/abc'],
];

describe('administrator-only endpoints', () => {
  test.each(ENDPOINTS)('%s %s: guests get 401', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test.each(ENDPOINTS)('%s %s: students get 403 "Access denied"', async (method, url) => {
    const { agent } = await loginAs(app, { username: 'plain_student' });
    const res = await agent[method](url).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Access denied' });
  });

  test('a student cannot become an administrator by sending a role', async () => {
    const { agent } = await loginAs(app, { username: 'sneaky_student' });
    const res = await agent
      .get('/api/admin/dashboard?role=administrator')
      .set('X-Role', 'administrator');
    expect(res.status).toBe(403);
  });

  test("nothing is changed by a student's attempt", async () => {
    const { agent } = await loginAs(app, { username: 'vandal' });
    const venue = await createVenue({ name: 'Untouched' });
    await agent.patch(`/api/admin/venues/${venue.id}`).send({ name: 'Hacked' });
    await agent.post(`/api/admin/venues/${venue.id}/deactivate`);
    const page = await request(app).get(`/api/venues/${venue.id}`);
    expect(page.status).toBe(200);
    expect(page.body.venue.name).toBe('Untouched');
  });

  test('an administrator who is demoted loses access on the very next request', async () => {
    const { agent, user } = await loginAs(app, { role: 'administrator', username: 'temp_admin' });
    expect((await agent.get('/api/admin/dashboard')).status).toBe(200);
    await user.update({ role: 'student' });
    expect((await agent.get('/api/admin/dashboard')).status).toBe(403);
  });

  test('administrators see not-found as 404, as normal', async () => {
    const { agent } = await loginAs(app, { role: 'administrator' });
    expect((await agent.get('/api/admin/anything-else')).status).toBe(404);
  });
});
