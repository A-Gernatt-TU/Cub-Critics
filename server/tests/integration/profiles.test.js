// Profiles, bio and profile pictures (FR#11-FR#15).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubcritics-profile-uploads-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const {
  resetDb,
  closeAll,
  loginAs,
  createUser,
  createVenue,
  createReview,
  seedAchievements,
} = require('./helpers');

beforeEach(async () => {
  await resetDb();
  // The database is reset between tests; so must the folder uploaded files go to.
  fs.rmSync(path.join(uploadDir, 'profile-pictures'), { recursive: true, force: true });
});
afterAll(async () => {
  await closeAll();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const MB = 1024 * 1024;
const png = (extra = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(20, 1),
    extra,
  ]);
const jpeg = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.from('JFIF'),
    Buffer.alloc(30, 1),
  ]);
const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;
const stored = () => {
  const dir = path.join(uploadDir, 'profile-pictures');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe('GET /api/users/:id: a public profile (FR#11, FR#15)', () => {
  test('shows username, picture, bio, join date, review count and badges, and nothing private', async () => {
    await seedAchievements();
    const { agent, user } = await loginAs(app, {
      username: 'tiger_fan',
      email: 'secret.address@example.com',
    });
    await agent.patch('/api/users/me').send({ bio: 'I love tacos' });
    const venues = [await createVenue(), await createVenue()];
    await agent.post(`/api/venues/${venues[0].id}/reviews`).send({ rating: 5 });
    await agent.post(`/api/venues/${venues[1].id}/reviews`).send({ rating: 3 });

    const res = await request(app).get(`/api/users/${user.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: user.id,
      username: 'tiger_fan',
      bio: 'I love tacos',
      profilePictureUrl: null,
      joinedAt: expect.any(String),
      reviewCount: 2,
      achievements: [
        {
          id: expect.any(Number),
          name: 'First Bite',
          reviewThreshold: 1,
          earnedAt: expect.any(String),
        },
      ],
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/secret\.address|example\.com|password|role|status|locked|tos_/i);
  });

  test('the review count includes only publicly visible reviews', async () => {
    const { user } = await createUser();
    for (const status of ['published', 'reported', 'flagged', 'removed']) {
      await createReview({ user, venue: await createVenue(), status });
    }
    expect((await request(app).get(`/api/users/${user.id}`)).body.user.reviewCount).toBe(2);
  });

  test('a new student has an empty profile, not an error', async () => {
    const { user } = await createUser();
    expect((await request(app).get(`/api/users/${user.id}`)).body.user).toMatchObject({
      bio: null,
      reviewCount: 0,
      achievements: [],
    });
  });

  test('administrators have ordinary profiles that do not reveal their role', async () => {
    const { user } = await createUser({ role: 'administrator' });
    const res = await request(app).get(`/api/users/${user.id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/administrator/i);
  });

  test('unknown, deactivated and impossible ids are 404', async () => {
    const { user } = await createUser({ status: 'deactivated' });
    for (const id of [user.id, 424242, 'abc', 'me', 0, 2147483648]) {
      const res = await request(app).get(`/api/users/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('GET /api/users/:id/reviews: their public reviews', () => {
  test('lists visible reviews with the venue, newest first, without moderation details', async () => {
    const { user } = await createUser({ username: 'profile_owner' });
    const [a, b, c, d] = [
      await createVenue({ name: 'Alpha' }),
      await createVenue({ name: 'Bravo' }),
      await createVenue({ name: 'Charlie' }),
      await createVenue({ name: 'Delta' }),
    ];
    await createReview({
      user,
      venue: a,
      rating: 5,
      body: 'old',
      createdAt: new Date('2026-10-01T12:00:00Z'),
    });
    await createReview({
      user,
      venue: b,
      rating: 3,
      body: 'newer',
      createdAt: new Date('2026-10-02T12:00:00Z'),
      status: 'reported',
    });
    await createReview({ user, venue: c, body: 'hidden', status: 'flagged' });
    await createReview({ user, venue: d, body: 'gone', status: 'removed' });

    const res = await request(app).get(`/api/users/${user.id}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.reviews).toEqual([
      {
        id: expect.any(Number),
        rating: 3,
        body: 'newer',
        createdAt: expect.any(String),
        edited: false,
        editedAt: null,
        venue: { id: b.id, name: 'Bravo' },
      },
      {
        id: expect.any(Number),
        rating: 5,
        body: 'old',
        createdAt: expect.any(String),
        edited: false,
        editedAt: null,
        venue: { id: a.id, name: 'Alpha' },
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/status/);
  });

  test('reviews of deactivated venues are not shown', async () => {
    const { user } = await createUser();
    await createReview({ user, venue: await createVenue({ status: 'inactive' }), body: 'x' });
    expect((await request(app).get(`/api/users/${user.id}/reviews`)).body).toEqual({
      reviews: [],
      total: 0,
    });
  });

  test('paging works and bad paging is a 400', async () => {
    const { user } = await createUser();
    for (let i = 0; i < 3; i += 1)
      await createReview({
        user,
        venue: await createVenue(),
        body: `r${i}`,
        createdAt: new Date(Date.UTC(2026, 9, i + 1)),
      });
    const page = (await request(app).get(`/api/users/${user.id}/reviews?limit=2&offset=1`)).body;
    expect(page.reviews.map((r) => r.body)).toEqual(['r1', 'r0']);
    expect(page.total).toBe(3);
    expect((await request(app).get(`/api/users/${user.id}/reviews?limit=999`)).status).toBe(400);
  });

  test('unknown and deactivated users are 404', async () => {
    const { user } = await createUser({ status: 'deactivated' });
    expect((await request(app).get(`/api/users/${user.id}/reviews`)).status).toBe(404);
    expect((await request(app).get('/api/users/424242/reviews')).status).toBe(404);
  });
});

describe('GET /api/users/me/reviews: my history (FR#14)', () => {
  test("lists ALL my reviews with the venue, rating, date and status, and no one else's", async () => {
    const me = await loginAs(app, { username: 'history_owner' });
    const other = await createUser();
    const venues = [
      await createVenue({ name: 'One' }),
      await createVenue({ name: 'Two' }),
      await createVenue({ name: 'Three' }),
      await createVenue({ name: 'Four' }),
    ];
    await createReview({
      user: me.user,
      venue: venues[0],
      status: 'published',
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    await createReview({
      user: me.user,
      venue: venues[1],
      status: 'reported',
      createdAt: new Date('2026-10-02T00:00:00Z'),
    });
    await createReview({
      user: me.user,
      venue: venues[2],
      status: 'flagged',
      createdAt: new Date('2026-10-03T00:00:00Z'),
    });
    await createReview({
      user: me.user,
      venue: venues[3],
      status: 'removed',
      createdAt: new Date('2026-10-04T00:00:00Z'),
    });
    await createReview({ user: other.user, venue: venues[0], body: 'not mine' });

    const res = await me.agent.get('/api/users/me/reviews');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.reviews.map((r) => [r.venue.name, r.status])).toEqual([
      ['Four', 'removed'],
      ['Three', 'flagged'],
      ['Two', 'reported'],
      ['One', 'published'],
    ]);
    expect(res.body.reviews[0]).toMatchObject({
      rating: 5,
      createdAt: expect.any(String),
      venue: { id: venues[3].id, name: 'Four' },
    });
  });

  test('needs a login', async () => {
    expect((await request(app).get('/api/users/me/reviews')).status).toBe(401);
  });
});

describe('PATCH /api/users/me: bio (FR#12)', () => {
  test('sets the bio and returns the account', async () => {
    const me = await loginAs(app, { email: 'bio@example.com' });
    const res = await me.agent.patch('/api/users/me').send({ bio: '  Hello there  ' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ bio: 'Hello there', email: 'bio@example.com' });
    expect((await User.findByPk(me.user.id)).bio).toBe('Hello there');
  });

  test('up to 250 characters; 251 is refused with a clear message', async () => {
    const me = await loginAs(app);
    expect((await me.agent.patch('/api/users/me').send({ bio: 'x'.repeat(250) })).status).toBe(200);
    const res = await me.agent.patch('/api/users/me').send({ bio: 'x'.repeat(251) });
    expect(res.status).toBe(400);
    expect(field(res, 'bio')).toBe('Bio must be 250 characters or fewer');
    expect((await User.findByPk(me.user.id)).bio).toHaveLength(250);
  });

  test('null or blank clears the bio', async () => {
    const me = await loginAs(app);
    for (const bio of [null, '', '   ']) {
      await me.agent.patch('/api/users/me').send({ bio: 'something' });
      expect((await me.agent.patch('/api/users/me').send({ bio })).body.user.bio).toBeNull();
    }
  });

  test('missing, non-text and unsafe values are refused', async () => {
    const me = await loginAs(app);
    for (const body of [{}, { bio: 5 }, { bio: ['a'] }, { bio: 'a\u0000b' }, { bio: 'a\u202Eb' }]) {
      expect((await me.agent.patch('/api/users/me').send(body)).status).toBe(400);
    }
  });

  test('only the bio can be changed: role, username, email and status are ignored', async () => {
    const me = await loginAs(app, { username: 'keep_name', email: 'keep@example.com' });
    await me.agent.patch('/api/users/me').send({
      bio: 'hi',
      role: 'administrator',
      username: 'hacked',
      email: 'new@example.com',
      status: 'deactivated',
      password_hash: 'x',
    });
    expect(await User.findByPk(me.user.id)).toMatchObject({
      role: 'student',
      username: 'keep_name',
      email: 'keep@example.com',
      status: 'active',
    });
  });

  test('guests get 401', async () => {
    expect((await request(app).patch('/api/users/me').send({ bio: 'x' })).status).toBe(401);
  });

  test('people can only change their own profile (there is no way to name another)', async () => {
    const me = await loginAs(app, { username: 'me_only' });
    const other = await createUser({ username: 'someone_else' });
    expect(
      (await me.agent.patch(`/api/users/${other.user.id}`).send({ bio: 'hacked' })).status
    ).toBe(404);
    expect((await User.findByPk(other.user.id)).bio).toBeNull();
  });
});

describe('PUT /api/users/me/picture (FR#13)', () => {
  const upload = (agent, buffer, filename = 'me.png', fieldName = 'file') =>
    agent.put('/api/users/me/picture').attach(fieldName, buffer, filename);

  test('uploads a PNG or JPG; the account and the public profile point at it; the image is served', async () => {
    const me = await loginAs(app);
    const res = await upload(me.agent, png());
    expect(res.status).toBe(200);
    expect(res.body.user.profilePictureUrl).toMatch(
      /^\/api\/files\/profile-pictures\/[0-9a-f-]{36}\.png$/
    );

    expect((await request(app).get(`/api/users/${me.user.id}`)).body.user.profilePictureUrl).toBe(
      res.body.user.profilePictureUrl
    );
    const img = await request(app).get(res.body.user.profilePictureUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);

    const jpg = await loginAs(app, { username: 'jpg_user' });
    expect((await upload(jpg.agent, jpeg(), 'photo.jpg')).body.user.profilePictureUrl).toMatch(
      /\.jpg$/
    );
  });

  test('replacing a picture removes the old file', async () => {
    const me = await loginAs(app);
    const first = (await upload(me.agent, png())).body.user.profilePictureUrl;
    expect(stored()).toHaveLength(1);
    const second = (await upload(me.agent, jpeg(), 'new.jpg')).body.user.profilePictureUrl;
    expect(second).not.toBe(first);
    expect(stored()).toHaveLength(1);
    expect((await request(app).get(first)).status).toBe(404);
    expect((await request(app).get(second)).status).toBe(200);
  });

  test('other files are refused with an error message, and the current picture is kept', async () => {
    const me = await loginAs(app);
    const good = (await upload(me.agent, png())).body.user.profilePictureUrl;
    for (const [buffer, name] of [
      [Buffer.from('GIF89a' + 'x'.repeat(40)), 'a.gif'],
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'a.png',
      ],
      [Buffer.from('<?php echo 1; ?>' + ' '.repeat(40)), 'a.jpg'],
    ]) {
      const res = await upload(me.agent, buffer, name);
      expect(res.status).toBe(400);
      expect(field(res, 'file')).toBe('Only JPG or PNG images are allowed');
    }
    expect((await User.findByPk(me.user.id)).profile_picture_key).toContain(good.split('/').pop());
    expect(stored()).toHaveLength(1);
  });

  test('over 2 MB is refused', async () => {
    const me = await loginAs(app);
    const res = await upload(me.agent, png(Buffer.alloc(2 * MB + 10, 7)));
    expect(res.status).toBe(400);
    expect(field(res, 'file')).toBe('Profile picture must be 2 MB or smaller');
    expect(stored()).toHaveLength(0);
  });

  test('no file, or the wrong field name, is refused', async () => {
    const me = await loginAs(app);
    expect(field(await me.agent.put('/api/users/me/picture'), 'file')).toBe(
      'Please choose an image to upload'
    );
    expect((await upload(me.agent, png(), 'a.png', 'avatar')).status).toBe(400);
  });

  test('guests cannot upload', async () => {
    const res = await request(app).put('/api/users/me/picture').attach('file', png(), 'a.png');
    expect(res.status).toBe(401);
    expect(stored()).toHaveLength(0);
  });

  test("a picture from another site cannot be uploaded on someone's behalf", async () => {
    const me = await loginAs(app);
    const res = await me.agent
      .put('/api/users/me/picture')
      .set('Origin', 'https://evil.example')
      .attach('file', png(), 'a.png');
    expect(res.status).toBe(403);
    expect(stored()).toHaveLength(0);
  });

  test("the picture shows up beside the student's reviews", async () => {
    const me = await loginAs(app, { username: 'with_picture' });
    const venue = await createVenue();
    const url = (await upload(me.agent, png())).body.user.profilePictureUrl;
    await me.agent.post(`/api/venues/${venue.id}/reviews`).send({ rating: 4 });
    const [review] = (await request(app).get(`/api/venues/${venue.id}/reviews`)).body.reviews;
    expect(review.author.profilePictureUrl).toBe(url);
  });
});
