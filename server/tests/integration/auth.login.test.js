const bcrypt = require('bcrypt');
const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { resetDb, closeAll, createUser, getSetCookie, sequelize } = require('./helpers');

beforeEach(resetDb);
afterEach(() => jest.restoreAllMocks());
afterAll(closeAll);

const login = (agent, body) => agent.post('/api/auth/login').send(body);
const fresh = () => request(app);
const dbUser = (id) => User.findByPk(id, { attributes: ['failed_login_count', 'locked_until'] });

describe('POST /api/auth/login: success (FR#4)', () => {
  test('logs in with email and password and returns the account', async () => {
    const { user, password } = await createUser({ email: 'jo@example.com', username: 'jo' });
    const res = await login(fresh(), { email: 'jo@example.com', password });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: user.id,
      username: 'jo',
      email: 'jo@example.com',
      role: 'student',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(getSetCookie(res)).toMatch(/HttpOnly/);
  });

  test('the session works afterwards', async () => {
    const { password } = await createUser({ email: 'jo@example.com', username: 'jo' });
    const agent = request.agent(app);
    await login(agent, { email: 'jo@example.com', password });
    expect((await agent.get('/api/auth/me')).body.user.username).toBe('jo');
  });

  test('email is case-insensitive and surrounding spaces are ignored', async () => {
    const { password } = await createUser({ email: 'mixed.case@example.com' });
    const res = await login(fresh(), { email: '  MIXED.Case@Example.COM ', password });
    expect(res.status).toBe(200);
  });

  test('works for an account whose stored email has capitals (e.g. a seeded admin)', async () => {
    const { password } = await createUser({ email: 'Admin@Example.com', role: 'administrator' });
    const res = await login(fresh(), { email: 'admin@example.com', password });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('administrator');
  });

  test('the password is case-sensitive and not trimmed', async () => {
    const { password } = await createUser({ email: 'jo@example.com' });
    expect(
      (await login(fresh(), { email: 'jo@example.com', password: password.toUpperCase() })).status
    ).toBe(401);
    expect(
      (await login(fresh(), { email: 'jo@example.com', password: ` ${password}` })).status
    ).toBe(401);
  });

  test('sessions use the role-specific idle timeout: 30 min students, 15 min administrators (SC#12)', async () => {
    const student = await createUser({ email: 's@example.com', username: 'stu' });
    const admin = await createUser({
      email: 'a@example.com',
      username: 'adm',
      role: 'administrator',
    });
    const studentRes = await login(fresh(), { email: 's@example.com', password: student.password });
    const adminRes = await login(fresh(), { email: 'a@example.com', password: admin.password });

    const expiresIn = (res) =>
      Date.parse(getSetCookie(res).match(/Expires=([^;]+)/)[1]) - Date.now();
    expect(Math.abs(expiresIn(studentRes) - 30 * 60 * 1000)).toBeLessThan(10000);
    expect(Math.abs(expiresIn(adminRes) - 15 * 60 * 1000)).toBeLessThan(10000);

    const [rows] = await sequelize.query(
      `SELECT user_id, EXTRACT(EPOCH FROM (expire - NOW())) AS seconds FROM sessions ORDER BY user_id`
    );
    expect(Math.abs(rows.find((r) => r.user_id === student.user.id).seconds - 1800)).toBeLessThan(
      10
    );
    expect(Math.abs(rows.find((r) => r.user_id === admin.user.id).seconds - 900)).toBeLessThan(10);
  });

  test('works with a hash created at a different bcrypt cost (like the cost-12 seeded admin)', async () => {
    const hash = await bcrypt.hash('SeedAdmin123', 10);
    await sequelize.query(
      `INSERT INTO users (email, username, password_hash, role, tos_version, tos_accepted_at)
       VALUES ('seed@example.com', 'seeded', :hash, 'administrator', 'seed', NOW())`,
      { replacements: { hash } }
    );
    expect(
      (await login(fresh(), { email: 'seed@example.com', password: 'SeedAdmin123' })).status
    ).toBe(200);
  });
});

describe('POST /api/auth/login: failure (FR#5)', () => {
  test('a wrong password and an unknown email give the SAME answer', async () => {
    await createUser({ email: 'jo@example.com' });
    const wrongPassword = await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    const unknownEmail = await login(fresh(), {
      email: 'nobody@example.com',
      password: 'WrongPass1',
    });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('Invalid email or password');
      expect(res.body.error.details).toBeUndefined();
      expect(getSetCookie(res)).toBeUndefined();
    }
  });

  test('an unknown email still does a bcrypt check, so timing does not reveal accounts', async () => {
    const spy = jest.spyOn(bcrypt, 'compare');
    await login(fresh(), { email: 'nobody@example.com', password: 'WrongPass1' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a deactivated account cannot log in, even with the right password, and gets the same answer', async () => {
    const { password } = await createUser({ email: 'gone@example.com', status: 'deactivated' });
    const res = await login(fresh(), { email: 'gone@example.com', password });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
    expect(getSetCookie(res)).toBeUndefined();
  });

  test('a password longer than 72 bytes never matches (bcrypt would ignore the extra characters)', async () => {
    const long = 'a'.repeat(71) + '1';
    await createUser({ email: 'jo@example.com', password: long });
    expect((await login(fresh(), { email: 'jo@example.com', password: long })).status).toBe(200);
    expect(
      (await login(fresh(), { email: 'jo@example.com', password: `${long}EXTRA` })).status
    ).toBe(401);
  });

  test('missing fields are reported per field', async () => {
    const res = await login(fresh(), {});
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['email', 'password']);
  });

  test('wrong types are rejected without crashing', async () => {
    const res = await login(fresh(), { email: { $ne: '' }, password: ['x'] });
    expect(res.status).toBe(400);
  });

  test('SQL-injection style input is just a failed login', async () => {
    await createUser({ email: 'jo@example.com' });
    const res = await login(fresh(), {
      email: "jo@example.com' OR '1'='1",
      password: "x' OR '1'='1",
    });
    expect(res.status).toBe(401);
  });
});

describe('Login lockout (FR#6)', () => {
  test('5 consecutive failures lock the account for 15 minutes', async () => {
    const { user, password } = await createUser({ email: 'jo@example.com' });
    const wrong = () => login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });

    for (let i = 1; i <= 4; i += 1) {
      const res = await wrong();
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    const fifth = await wrong();
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.body.error.message).toMatch(/Please try again in 15 minutes/);
    expect(Math.abs(Number(fifth.headers['retry-after']) - 900)).toBeLessThanOrEqual(2);

    const lockedUntil = (await dbUser(user.id)).locked_until;
    expect(Math.abs(lockedUntil - (Date.now() + 15 * 60 * 1000))).toBeLessThan(10000);

    // Further attempts are refused, even with the CORRECT password.
    const correctWhileLocked = await login(fresh(), { email: 'jo@example.com', password });
    expect(correctWhileLocked.status).toBe(429);
    expect(getSetCookie(correctWhileLocked)).toBeUndefined();
  });

  test('attempts while locked do not extend the lock', async () => {
    const { user } = await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 5; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    const before = (await dbUser(user.id)).locked_until.getTime();
    for (let i = 0; i < 3; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    expect((await dbUser(user.id)).locked_until.getTime()).toBe(before);
  });

  test('once the 15 minutes pass, the right password works and the counter resets', async () => {
    const { user, password } = await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 5; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    await sequelize.query(
      `UPDATE users SET locked_until = NOW() - INTERVAL '1 second' WHERE id = :id`,
      {
        replacements: { id: user.id },
      }
    );

    const res = await login(fresh(), { email: 'jo@example.com', password });
    expect(res.status).toBe(200);
    expect(await dbUser(user.id)).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  test('after a lock runs out, a wrong password starts a FRESH count (no instant re-lock)', async () => {
    const { user } = await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 5; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    await sequelize.query(
      `UPDATE users SET locked_until = NOW() - INTERVAL '1 second' WHERE id = :id`,
      {
        replacements: { id: user.id },
      }
    );

    const res = await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(await dbUser(user.id)).toMatchObject({ failed_login_count: 1, locked_until: null });
  });

  test('a successful login resets the failure counter, so failures must be CONSECUTIVE', async () => {
    const { user, password } = await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 4; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    expect((await dbUser(user.id)).failed_login_count).toBe(4);

    expect((await login(fresh(), { email: 'jo@example.com', password })).status).toBe(200);
    expect((await dbUser(user.id)).failed_login_count).toBe(0);

    for (let i = 0; i < 4; i += 1) {
      expect(
        (await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' })).status
      ).toBe(401);
    }
  });

  test('the 5th attempt can still succeed if the password is right', async () => {
    const { password } = await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 4; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    const res = await login(fresh(), { email: 'jo@example.com', password });
    expect(res.status).toBe(200);
  });

  test('a burst of 20 parallel guesses gets at most 5 real password checks (no race)', async () => {
    const { user } = await createUser({ email: 'jo@example.com' });
    const spy = jest.spyOn(bcrypt, 'compare');

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        login(fresh(), { email: 'jo@example.com', password: `WrongGuess${i}` })
      )
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(16);
    expect(spy).toHaveBeenCalledTimes(5);
    expect((await dbUser(user.id)).locked_until.getTime()).toBeGreaterThan(Date.now());
  });

  test('locking one account does not affect another', async () => {
    await createUser({ email: 'victim@example.com', username: 'victim' });
    const other = await createUser({ email: 'other@example.com', username: 'other' });
    for (let i = 0; i < 5; i += 1) {
      await login(fresh(), { email: 'victim@example.com', password: 'WrongPass1' });
    }
    expect(
      (await login(fresh(), { email: 'other@example.com', password: other.password })).status
    ).toBe(200);
  });
});

describe('Login sessions (SC#5)', () => {
  test('logging in issues a NEW session id (prevents session fixation) and removes the old one', async () => {
    const first = await createUser({ email: 'one@example.com', username: 'one' });
    const second = await createUser({ email: 'two@example.com', username: 'two' });
    const agent = request.agent(app);

    const a = await login(agent, { email: 'one@example.com', password: first.password });
    const b = await login(agent, { email: 'two@example.com', password: second.password });

    expect(getSetCookie(a)).not.toBe(getSetCookie(b));
    expect((await agent.get('/api/auth/me')).body.user.username).toBe('two');
    const [rows] = await sequelize.query('SELECT user_id FROM sessions');
    expect(rows).toEqual([{ user_id: second.user.id }]);
  });

  test('a session id planted before login is not accepted afterwards', async () => {
    const { password } = await createUser({ email: 'jo@example.com' });
    const attacker = request.agent(app);
    const victim = request.agent(app);
    await victim.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'x' }); // no session yet
    const planted = 'cubcritics.sid=s%3Aplanted-session-id.fakesignature';
    const res = await request(app)
      .post('/api/auth/login')
      .set('Cookie', planted)
      .send({ email: 'jo@example.com', password });
    expect(res.status).toBe(200);
    expect(getSetCookie(res)).not.toContain('planted-session-id');
    expect((await attacker.get('/api/auth/me').set('Cookie', planted)).body.user).toBeNull();
  });
});

describe('Audit log (AL#3)', () => {
  test('records successful and failed logins with the IP, never passwords or attempted emails', async () => {
    const { user, password } = await createUser({ email: 'jo@example.com' });
    await login(fresh(), { email: 'jo@example.com', password: 'SecretWrong99' });
    await login(fresh(), { email: 'ghost.typo@example.com', password: 'SecretWrong99' });
    await login(fresh(), { email: 'jo@example.com', password });

    const [rows] = await sequelize.query(
      'SELECT actor_id, event_type, ip_address, details FROM audit_log ORDER BY id'
    );
    expect(rows.map((r) => r.event_type)).toEqual([
      'login_failed',
      'login_failed',
      'login_success',
    ]);
    expect(rows[0]).toMatchObject({ actor_id: user.id, details: { reason: 'wrong_password' } });
    expect(rows[1]).toMatchObject({ actor_id: null, details: { reason: 'unknown_account' } });
    expect(rows[2].actor_id).toBe(user.id);
    expect(rows.every((r) => r.ip_address)).toBe(true);

    const everything = JSON.stringify(rows);
    expect(everything).not.toMatch(/SecretWrong99|Passw0rdTest|ghost\.typo|\$2[aby]\$/);
  });

  test('records the lockout and refused attempts', async () => {
    await createUser({ email: 'jo@example.com' });
    for (let i = 0; i < 6; i += 1)
      await login(fresh(), { email: 'jo@example.com', password: 'WrongPass1' });
    const [rows] = await sequelize.query('SELECT event_type FROM audit_log ORDER BY id');
    expect(rows.map((r) => r.event_type)).toEqual([
      'login_failed',
      'login_failed',
      'login_failed',
      'login_failed',
      'account_locked',
      'login_locked',
    ]);
  });

  test('a failure to write the audit log does not break login', async () => {
    const { password } = await createUser({ email: 'jo@example.com' });
    await sequelize.query('ALTER TABLE audit_log RENAME TO audit_log_hidden');
    try {
      const res = await login(fresh(), { email: 'jo@example.com', password });
      expect(res.status).toBe(200);
    } finally {
      await sequelize.query('ALTER TABLE audit_log_hidden RENAME TO audit_log');
    }
  });
});
