const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
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

const register = (body) => request(app).post('/api/auth/register').send(body);
const fieldsOf = (res) => res.body.error.details.map((d) => d.field).sort();
const messageFor = (res, field) => res.body.error.details.find((d) => d.field === field)?.message;

describe('POST /api/auth/register: success (FR#1, FR#2)', () => {
  test('creates a student, returns only safe fields, and logs the student in', async () => {
    const res = await register(validRegistration());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.user).sort()).toEqual(
      ['bio', 'createdAt', 'email', 'id', 'profilePictureKey', 'role', 'username'].sort()
    );
    expect(res.body.user).toMatchObject({
      email: 'new.student@example.com',
      username: 'new_student',
      role: 'student',
      bio: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|tos_|locked|failed/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('sets a secure session cookie (SC#5)', async () => {
    const res = await register(validRegistration());
    const cookie = getSetCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/SameSite=Lax/);
    // 30 minutes (SC#12), give or take a few seconds
    const expires = Date.parse(cookie.match(/Expires=([^;]+)/)[1]);
    expect(Math.abs(expires - (Date.now() + 30 * 60 * 1000))).toBeLessThan(10000);
  });

  test('the new student is already logged in', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send(validRegistration());
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.username).toBe('new_student');
  });

  test('stores a bcrypt hash, the ToS acceptance (FR#2, FR#53), and a lowercase email', async () => {
    await register(validRegistration({ email: '  New.Student@Example.COM ' }));
    const user = await User.scope('withPassword').findOne({ where: { username: 'new_student' } });
    expect(user.email).toBe('new.student@example.com');
    expect(user.password_hash).toMatch(/^\$2[aby]\$04\$/); // bcrypt, cost 4 in tests
    expect(user.password_hash).not.toContain('Passw0rd1');
    expect(user.tos_version).toBe('test-1');
    expect(Math.abs(user.tos_accepted_at - Date.now())).toBeLessThan(10000);
    expect(user.status).toBe('active');
    expect(user.failed_login_count).toBe(0);
  });

  test('links the session to the user so it can be revoked (SC#13)', async () => {
    const res = await register(validRegistration());
    const [rows] = await sequelize.query('SELECT user_id FROM sessions');
    expect(rows).toEqual([{ user_id: res.body.user.id }]);
  });

  test('writes a register entry to the audit log with the IP', async () => {
    const res = await register(validRegistration());
    const [rows] = await sequelize.query('SELECT actor_id, event_type, ip_address FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: res.body.user.id, event_type: 'register' });
    expect(rows[0].ip_address).toBeTruthy();
  });

  test('ignores a role (or any other extra field) in the request: no privilege escalation', async () => {
    const res = await register(
      validRegistration({ role: 'administrator', status: 'deactivated', id: 999, bio: 'x' })
    );
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('student');
    expect(res.body.user.id).not.toBe(999);
    const user = await User.findByPk(res.body.user.id);
    expect(user).toMatchObject({ role: 'student', status: 'active', bio: null });
  });

  test('trims the username but keeps its capitalization', async () => {
    const res = await register(validRegistration({ username: '  Tiger_Fan  ' }));
    expect(res.body.user.username).toBe('Tiger_Fan');
  });
});

describe('POST /api/auth/register: validation (FR#2, FR#3)', () => {
  test('an empty request lists every required field at once', async () => {
    const res = await register({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(res)).toEqual(['acceptTerms', 'email', 'password', 'username']);
    expect(messageFor(res, 'email')).toBe('Email is required');
  });

  test('no request body at all is handled', async () => {
    const res = await request(app).post('/api/auth/register');
    expect(res.status).toBe(400);
    expect(fieldsOf(res)).toEqual(['acceptTerms', 'email', 'password', 'username']);
  });

  test('a JSON array or string body is not accepted as a form', async () => {
    const res = await request(app).post('/api/auth/register').send([1, 2]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test.each([
    ['not-an-email'],
    ['missing@tld'],
    ['two@@example.com'],
    ['spaces in@example.com'],
    ['@example.com'],
  ])('rejects the malformed email %p', async (email) => {
    const res = await register(validRegistration({ email }));
    expect(res.status).toBe(400);
    expect(messageFor(res, 'email')).toBe('Enter a valid email address');
    expect(await User.count()).toBe(0);
  });

  test('rejects an email over 254 characters', async () => {
    const res = await register(validRegistration({ email: `${'a'.repeat(250)}@example.com` }));
    expect(messageFor(res, 'email')).toBe('Email is too long');
  });

  test.each([
    ['short1', 'Password must be at least 8 characters'],
    ['abcdefghi', 'Password must include at least one letter and one number'],
    ['12345678', 'Password must include at least one letter and one number'],
    ['a'.repeat(73) + '1', 'Password is too long (maximum 72 characters)'],
  ])('rejects the password %p', async (password, message) => {
    const res = await register(validRegistration({ password }));
    expect(res.status).toBe(400);
    expect(messageFor(res, 'password')).toBe(message);
    expect(fieldsOf(res)).toEqual(['password']); // one message per field
  });

  test('accepts the boundary passwords: exactly 8 and exactly 72 characters', async () => {
    expect((await register(validRegistration({ password: 'abcdefg1' }))).status).toBe(201);
    const long = 'a'.repeat(71) + '1';
    const res = await register(
      validRegistration({ email: 'long@example.com', username: 'long_pw', password: long })
    );
    expect(res.status).toBe(201);
  });

  test('counts password length in bytes, because bcrypt only uses 72', async () => {
    // 40 two-byte characters + digit = 81 bytes, but only 41 characters
    const res = await register(validRegistration({ password: 'é'.repeat(40) + '1' }));
    expect(messageFor(res, 'password')).toBe('Password is too long (maximum 72 characters)');
  });

  test.each([
    ['ab', 'Username must be at least 3 characters'],
    ['a'.repeat(31), 'Username must be 30 characters or fewer'],
    ['has space', 'Username can only contain letters, numbers and underscores'],
    ['semi;colon', 'Username can only contain letters, numbers and underscores'],
    ['<script>', 'Username can only contain letters, numbers and underscores'],
    ['Admin', 'That username is not available'],
    ['MODERATOR', 'That username is not available'],
  ])('rejects the username %p', async (username, message) => {
    const res = await register(validRegistration({ username }));
    expect(res.status).toBe(400);
    expect(messageFor(res, 'username')).toBe(message);
  });

  test('requires the Terms of Service to be accepted (FR#2)', async () => {
    for (const acceptTerms of [false, undefined, 'true', 1, null]) {
      const res = await register(validRegistration({ acceptTerms }));
      expect(res.status).toBe(400);
      expect(messageFor(res, 'acceptTerms')).toBe('You must accept the Terms of Service');
    }
    expect(await User.count()).toBe(0);
  });

  test('wrong data types give a clear message, not a crash', async () => {
    const res = await register({ email: 5, username: {}, password: ['x'], acceptTerms: true });
    expect(res.status).toBe(400);
    expect(messageFor(res, 'email')).toBe('Email must be text');
    expect(fieldsOf(res)).toEqual(['email', 'password', 'username']);
  });

  test('SQL injection text is just rejected or stored as plain data', async () => {
    const res = await register(validRegistration({ username: "x'; DROP TABLE users;--" }));
    expect(res.status).toBe(400);
    expect(await User.count()).toBe(0);
    const ok = await register(validRegistration({ email: "o'brien@example.com" }));
    expect([201, 400]).toContain(ok.status); // apostrophes in an email are legal but never executed
    await sequelize.query('SELECT 1 FROM users'); // table still exists
  });
});

describe('POST /api/auth/register: duplicates (FR#3)', () => {
  test('rejects an email already in use, ignoring letter case', async () => {
    await createUser({ email: 'taken@example.com', username: 'someone_else' });
    const res = await register(validRegistration({ email: 'TAKEN@Example.com' }));
    expect(res.status).toBe(400);
    expect(fieldsOf(res)).toEqual(['email']);
    expect(messageFor(res, 'email')).toBe('That email address is already registered');
    expect(await User.count()).toBe(1);
  });

  test('rejects a username already in use, ignoring letter case', async () => {
    await createUser({ email: 'other@example.com', username: 'TigerFan' });
    const res = await register(validRegistration({ username: 'tigerfan' }));
    expect(fieldsOf(res)).toEqual(['username']);
    expect(messageFor(res, 'username')).toBe('That username is already taken');
  });

  test('reports EVERY invalid field at once, next to each field', async () => {
    await createUser({ email: 'taken@example.com', username: 'taken_name' });
    const res = await register({
      email: 'taken@example.com',
      username: 'taken_name',
      password: 'abc',
      acceptTerms: false,
    });
    expect(res.status).toBe(400);
    expect(fieldsOf(res)).toEqual(['acceptTerms', 'email', 'password', 'username']);
    expect(messageFor(res, 'email')).toMatch(/already registered/);
    expect(messageFor(res, 'username')).toMatch(/already taken/);
    expect(messageFor(res, 'password')).toMatch(/at least 8/);
  });

  test('two people registering the same email at the same moment: one wins, one gets a field error', async () => {
    const responses = await Promise.all([
      register(validRegistration({ username: 'racer_one' })),
      register(validRegistration({ username: 'racer_two' })),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    const loser = responses.find((r) => r.status === 400);
    expect(loser.body.error.code).toBe('VALIDATION_ERROR');
    expect(messageFor(loser, 'email')).toMatch(/already registered/);
    expect(await User.count()).toBe(1);
  });

  test('a failed registration creates no session and no cookie', async () => {
    const res = await register({});
    expect(getSetCookie(res)).toBeUndefined();
    const [rows] = await sequelize.query('SELECT 1 FROM sessions');
    expect(rows).toHaveLength(0);
  });
});
