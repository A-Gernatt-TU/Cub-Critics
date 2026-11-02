// TBD-1: registration limited to certain email domains via ALLOWED_EMAIL_DOMAINS.
process.env.ALLOWED_EMAIL_DOMAINS = 'towson.edu';

const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { resetDb, closeAll, validRegistration } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const register = (email, username) =>
  request(app).post('/api/auth/register').send(validRegistration({ email, username }));

describe('ALLOWED_EMAIL_DOMAINS=towson.edu', () => {
  test.each([
    ['a.student@towson.edu', 'ok_one'],
    ['b.student@students.towson.edu', 'ok_two'],
    ['C.STUDENT@TOWSON.EDU', 'ok_three'],
  ])('accepts %s', async (email, username) => {
    const res = await register(email, username);
    expect(res.status).toBe(201);
  });

  test.each([
    ['someone@gmail.com'],
    ['someone@eviltowson.edu'],
    ['someone@towson.edu.evil.com'],
    ['someone@towson.com'],
    ['towson.edu@gmail.com'],
  ])('rejects %s with a message naming the allowed domain', async (email) => {
    const res = await register(email, 'blocked_user');
    expect(res.status).toBe(400);
    const detail = res.body.error.details.find((d) => d.field === 'email');
    expect(detail.message).toBe('Please use an email address from: towson.edu');
    expect(await User.count()).toBe(0);
  });
});
