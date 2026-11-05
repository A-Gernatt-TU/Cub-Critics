// Writing, editing and deleting reviews, and the badges they earn (FR#16, FR#24-FR#29, SC#11).
const request = require('supertest');
const app = require('../../app');
const { Review, UserAchievement } = require('../../models');
const {
  resetDb,
  closeAll,
  loginAs,
  createUser,
  createVenue,
  createReview,
  seedAchievements,
  sequelize,
} = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const STARS = 'Please choose a star rating from 1 to 5';
const post = (agent, venueId, body) => agent.post(`/api/venues/${venueId}/reviews`).send(body);
const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;
const venueRating = async (venueId) =>
  (await request(app).get(`/api/venues/${venueId}`)).body.venue;

describe('POST /api/venues/:id/reviews (FR#24, FR#25, FR#26)', () => {
  test('a student posts a rating with text and gets the review back', async () => {
    const { agent, user } = await loginAs(app, { username: 'critic_one' });
    const venue = await createVenue({ name: 'Paws' });
    const res = await post(agent, venue.id, { rating: 4, body: 'Great wraps' });

    expect(res.status).toBe(201);
    expect(res.body.review).toEqual({
      id: expect.any(Number),
      rating: 4,
      body: 'Great wraps',
      createdAt: expect.any(String),
      edited: false,
      editedAt: null,
      author: { id: user.id, username: 'critic_one', profilePictureUrl: null },
      mine: true,
      status: 'published',
    });
    expect(res.body.newAchievements).toEqual([]); // no badges seeded in this test
    expect(JSON.stringify(res.body)).not.toMatch(/@example\.com|password/i);
  });

  test('the text is optional: a rating alone is fine', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    for (const body of [{ rating: 5 }, { rating: 5, body: null }]) {
      await Review.destroy({ where: {} });
      const res = await post(agent, venue.id, body);
      expect(res.status).toBe(201);
      expect(res.body.review.body).toBeNull();
    }
  });

  test('blank or whitespace-only text is stored as no text', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    const res = await post(agent, venue.id, { rating: 3, body: '   \n  ' });
    expect(res.body.review.body).toBeNull();
  });

  test('text is trimmed, keeps line breaks, and HTML is kept as plain text', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    const res = await post(agent, venue.id, {
      rating: 3,
      body: '  Line one\r\nLine two <b>bold</b>  ',
    });
    expect(res.body.review.body).toBe('Line one\nLine two <b>bold</b>');
  });

  test('FR#26: a missing or invalid rating is rejected with a message next to the rating field', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    for (const body of [
      {},
      { body: 'text only' },
      { rating: 0 },
      { rating: 6 },
      { rating: -1 },
      { rating: 4.5 },
      { rating: '5' },
      { rating: null },
      { rating: true },
      { rating: [5] },
    ]) {
      const res = await post(agent, venue.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(field(res, 'rating')).toBe(STARS);
    }
    expect(await Review.count()).toBe(0);
  });

  test('all five star values work', async () => {
    const { agent } = await loginAs(app);
    for (const rating of [1, 2, 3, 4, 5]) {
      const venue = await createVenue();
      expect((await post(agent, venue.id, { rating })).status).toBe(201);
    }
  });

  test('FR#25: up to 1,000 characters; 1,001 is refused; emoji count as one character', async () => {
    const { agent } = await loginAs(app);
    const [a, b, c] = [await createVenue(), await createVenue(), await createVenue()];
    expect((await post(agent, a.id, { rating: 3, body: 'x'.repeat(1000) })).status).toBe(201);
    const tooLong = await post(agent, b.id, { rating: 3, body: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400);
    expect(field(tooLong, 'body')).toBe('Review must be 1000 characters or fewer');
    expect((await post(agent, c.id, { rating: 3, body: '😀'.repeat(1000) })).status).toBe(201);
  });

  test('control characters and hidden direction tricks in the text are refused', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    for (const body of ['a\u0007b', 'a\u001bb', 'a\u202Eb', 'a\u2028b']) {
      const res = await post(agent, venue.id, { rating: 3, body });
      expect(res.status).toBe(400);
      expect(field(res, 'body')).toBe('Review contains characters that are not allowed');
    }
  });

  test('wrong types for the text are refused', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    for (const body of [123, ['a'], { a: 1 }, true]) {
      expect((await post(agent, venue.id, { rating: 3, body })).status).toBe(400);
    }
  });

  test('extra fields are ignored: no choosing the author, status, venue or id', async () => {
    const { agent, user } = await loginAs(app);
    const other = await createUser();
    const venue = await createVenue();
    const elsewhere = await createVenue();
    const res = await post(agent, venue.id, {
      rating: 5,
      user_id: other.user.id,
      userId: other.user.id,
      venue_id: elsewhere.id,
      status: 'removed',
      id: 999,
      created_at: '2000-01-01',
    });
    expect(res.status).toBe(201);
    const stored = await Review.findByPk(res.body.review.id);
    expect(stored).toMatchObject({ user_id: user.id, venue_id: venue.id, status: 'published' });
    expect(stored.id).not.toBe(999);
    expect(stored.created_at.getFullYear()).toBeGreaterThan(2020);
  });

  test('guests cannot post (401); the review is not created', async () => {
    const venue = await createVenue();
    const res = await request(app).post(`/api/venues/${venue.id}/reviews`).send({ rating: 5 });
    expect(res.status).toBe(401);
    expect(await Review.count()).toBe(0);
  });

  test('administrators can review too (they have all student functions)', async () => {
    const { agent } = await loginAs(app, { role: 'administrator' });
    const venue = await createVenue();
    expect((await post(agent, venue.id, { rating: 5 })).status).toBe(201);
  });

  test('inactive, unknown and impossible venue ids are 404', async () => {
    const { agent } = await loginAs(app);
    const inactive = await createVenue({ status: 'inactive' });
    for (const id of [inactive.id, 424242, 'abc', 0, 2147483648]) {
      expect((await post(agent, id, { rating: 5 })).status).toBe(404);
    }
  });

  test('the venue average and review count update at once (FR#23)', async () => {
    const venue = await createVenue();
    const a = await loginAs(app, { username: 'rater_a' });
    const b = await loginAs(app, { username: 'rater_b' });
    await post(a.agent, venue.id, { rating: 5 });
    expect(await venueRating(venue.id)).toMatchObject({ avgRating: 5, reviewCount: 1 });
    await post(b.agent, venue.id, { rating: 2 });
    expect(await venueRating(venue.id)).toMatchObject({ avgRating: 3.5, reviewCount: 2 });
  });

  test("the new review appears in the venue's list", async () => {
    const { agent } = await loginAs(app, { username: 'poster' });
    const venue = await createVenue();
    await post(agent, venue.id, { rating: 4, body: 'hello' });
    const list = (await request(app).get(`/api/venues/${venue.id}/reviews`)).body;
    expect(list.reviews.map((r) => r.body)).toEqual(['hello']);
  });
});

describe('One review per student per venue (FR#27)', () => {
  test('a second review of the same venue is refused and points at the existing one', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    const first = await post(agent, venue.id, { rating: 5, body: 'first' });
    const second = await post(agent, venue.id, { rating: 1, body: 'second' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('REVIEW_ALREADY_EXISTS');
    expect(second.body.error.details).toEqual({ reviewId: first.body.review.id });
    expect(await Review.count()).toBe(1);
    expect((await Review.findByPk(first.body.review.id)).body).toBe('first');
  });

  test('two simultaneous submissions create exactly one review', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    const results = await Promise.all(
      [1, 2, 3, 4].map((rating) => post(agent, venue.id, { rating }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await Review.count()).toBe(1);
  });

  test('different venues, and different students, are independent', async () => {
    const a = await loginAs(app, { username: 'student_a' });
    const b = await loginAs(app, { username: 'student_b' });
    const [v1, v2] = [await createVenue(), await createVenue()];
    expect((await post(a.agent, v1.id, { rating: 5 })).status).toBe(201);
    expect((await post(a.agent, v2.id, { rating: 5 })).status).toBe(201);
    expect((await post(b.agent, v1.id, { rating: 5 })).status).toBe(201);
  });

  test('a student whose review a moderator removed cannot post another for that venue', async () => {
    const { agent, user } = await loginAs(app);
    const venue = await createVenue();
    await createReview({ user, venue, status: 'removed' });
    const res = await post(agent, venue.id, { rating: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVIEW_REMOVED');
  });

  test('GET .../reviews/mine: null before reviewing, the review (with its status) after', async () => {
    const { agent } = await loginAs(app);
    const venue = await createVenue();
    expect((await agent.get(`/api/venues/${venue.id}/reviews/mine`)).body).toEqual({
      review: null,
    });
    await post(agent, venue.id, { rating: 4, body: 'mine' });
    const res = await agent.get(`/api/venues/${venue.id}/reviews/mine`);
    expect(res.body.review).toMatchObject({
      rating: 4,
      body: 'mine',
      mine: true,
      status: 'published',
    });
  });

  test('"mine" shows my review even when a moderator hid it, and never someone else\'s', async () => {
    const me = await loginAs(app, { username: 'me_student' });
    const other = await createUser({ username: 'other_student' });
    const venue = await createVenue();
    await createReview({ user: other.user, venue, body: 'not mine' });
    expect((await me.agent.get(`/api/venues/${venue.id}/reviews/mine`)).body.review).toBeNull();
    await createReview({ user: me.user, venue, body: 'hidden', status: 'flagged' });
    expect((await me.agent.get(`/api/venues/${venue.id}/reviews/mine`)).body.review).toMatchObject({
      body: 'hidden',
      status: 'flagged',
    });
  });

  test('"mine" needs a login and a real venue', async () => {
    const venue = await createVenue();
    expect((await request(app).get(`/api/venues/${venue.id}/reviews/mine`)).status).toBe(401);
    const { agent } = await loginAs(app);
    expect((await agent.get('/api/venues/424242/reviews/mine')).status).toBe(404);
  });
});

describe('PATCH /api/reviews/:id: editing (FR#28)', () => {
  async function posted(overrides) {
    const me = await loginAs(app, overrides);
    const venue = await createVenue();
    const res = await post(me.agent, venue.id, { rating: 3, body: 'original' });
    return { ...me, venue, review: res.body.review };
  }
  const patch = (agent, id, body) => agent.patch(`/api/reviews/${id}`).send(body);

  test('changes the rating and/or text, and labels the review edited with the date', async () => {
    const { agent, review } = await posted();
    const res = await patch(agent, review.id, { rating: 5, body: 'better' });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ rating: 5, body: 'better', edited: true, mine: true });
    expect(Date.parse(res.body.review.editedAt)).toBeGreaterThan(Date.now() - 10000);
    expect(res.body.review.createdAt).toBe(review.createdAt); // the original date is kept
  });

  test('rating alone, or text alone', async () => {
    const { agent, review } = await posted();
    expect((await patch(agent, review.id, { rating: 1 })).body.review).toMatchObject({
      rating: 1,
      body: 'original',
    });
    expect((await patch(agent, review.id, { body: 'new text' })).body.review).toMatchObject({
      rating: 1,
      body: 'new text',
    });
  });

  test('null, empty or blank text removes the text', async () => {
    for (const body of [null, '', '   ']) {
      const { agent, review } = await posted({
        username: `editor_${String(body).length}${body === null}`,
      });
      const res = await patch(agent, review.id, { body });
      expect(res.status).toBe(200);
      expect(res.body.review.body).toBeNull();
    }
  });

  test('saving without changing anything does not mark the review as edited', async () => {
    const { agent, review } = await posted();
    const res = await patch(agent, review.id, { rating: 3, body: 'original' });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ edited: false, editedAt: null });
  });

  test('the venue average follows the edit', async () => {
    const { agent, review, venue } = await posted();
    await patch(agent, review.id, { rating: 5 });
    expect((await venueRating(venue.id)).avgRating).toBe(5);
  });

  test('an empty change, or invalid values, are refused', async () => {
    const { agent, review } = await posted();
    const empty = await patch(agent, review.id, {});
    expect(empty.status).toBe(400);
    expect(field(empty, 'rating')).toBe('Send a new rating or new review text');
    expect(field(await patch(agent, review.id, { rating: 9 }), 'rating')).toBe(STARS);
    expect(field(await patch(agent, review.id, { body: 'x'.repeat(1001) }), 'body')).toBe(
      'Review must be 1000 characters or fewer'
    );
    expect((await Review.findByPk(review.id)).edited_at).toBeNull();
  });

  test("SC#11: nobody can edit someone else's review, not even an administrator", async () => {
    const { review } = await posted({ username: 'author_one' });
    const stranger = await loginAs(app, { username: 'stranger' });
    const admin = await loginAs(app, { username: 'the_admin', role: 'administrator' });
    for (const who of [stranger, admin]) {
      const res = await patch(who.agent, review.id, { rating: 1, body: 'vandalized' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Access denied');
    }
    expect(await Review.findByPk(review.id)).toMatchObject({
      rating: 3,
      body: 'original',
      edited_at: null,
    });
  });

  test('extra fields cannot be used to change the owner, venue or status', async () => {
    const { agent, review, user, venue } = await posted();
    const other = await createUser();
    await patch(agent, review.id, {
      rating: 4,
      user_id: other.user.id,
      venue_id: 999,
      status: 'removed',
      created_at: '2001-01-01',
    });
    expect(await Review.findByPk(review.id)).toMatchObject({
      user_id: user.id,
      venue_id: venue.id,
      status: 'published',
      rating: 4,
    });
  });

  test('guests get 401; unknown and impossible ids get 404', async () => {
    const { review } = await posted();
    expect((await request(app).patch(`/api/reviews/${review.id}`).send({ rating: 1 })).status).toBe(
      401
    );
    const { agent } = await loginAs(app);
    for (const id of [424242, 'abc', 0, 2147483648])
      expect((await patch(agent, id, { rating: 1 })).status).toBe(404);
  });

  test('a reported review can still be edited (it stays reported); a flagged or removed one cannot', async () => {
    const { agent, review } = await posted();
    await Review.update({ status: 'reported' }, { where: { id: review.id } });
    const ok = await patch(agent, review.id, { rating: 4 });
    expect(ok.status).toBe(200);
    expect((await Review.findByPk(review.id)).status).toBe('reported');

    for (const status of ['flagged', 'removed']) {
      await Review.update({ status }, { where: { id: review.id } });
      const res = await patch(agent, review.id, { rating: 1 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVIEW_LOCKED');
      expect((await Review.findByPk(review.id)).rating).toBe(4);
    }
  });
});

describe('DELETE /api/reviews/:id (FR#29)', () => {
  async function posted(overrides) {
    const me = await loginAs(app, overrides);
    const venue = await createVenue();
    const res = await post(me.agent, venue.id, { rating: 2, body: 'meh' });
    return { ...me, venue, review: res.body.review };
  }

  test('the author deletes their review; the venue average updates; they may review again', async () => {
    const { agent, review, venue } = await posted();
    const res = await agent.delete(`/api/reviews/${review.id}`);
    expect(res.status).toBe(204);
    expect(await Review.findByPk(review.id)).toBeNull();
    expect(await venueRating(venue.id)).toMatchObject({ avgRating: null, reviewCount: 0 });
    expect((await post(agent, venue.id, { rating: 5 })).status).toBe(201);
  });

  test('SC#11: nobody else can delete it, not even an administrator', async () => {
    const { review } = await posted({ username: 'author_two' });
    const stranger = await loginAs(app, { username: 'stranger_2' });
    const admin = await loginAs(app, { username: 'admin_2', role: 'administrator' });
    for (const who of [stranger, admin]) {
      expect((await who.agent.delete(`/api/reviews/${review.id}`)).status).toBe(403);
    }
    expect(await Review.findByPk(review.id)).not.toBeNull();
  });

  test('a flagged or removed review cannot be deleted by its author (no dodging a moderator)', async () => {
    const { agent, review } = await posted();
    for (const status of ['flagged', 'removed']) {
      await Review.update({ status }, { where: { id: review.id } });
      const res = await agent.delete(`/api/reviews/${review.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVIEW_LOCKED');
      expect(await Review.findByPk(review.id)).not.toBeNull();
    }
  });

  test('a removed review cannot be deleted to get around the one-review rule', async () => {
    const { agent, review, venue } = await posted();
    await Review.update({ status: 'removed' }, { where: { id: review.id } });
    await agent.delete(`/api/reviews/${review.id}`);
    expect((await post(agent, venue.id, { rating: 5 })).body.error.code).toBe('REVIEW_REMOVED');
  });

  test('a reported review can be deleted, and its reports go with it', async () => {
    const { agent, review } = await posted();
    const reporter = await createUser();
    await Review.update({ status: 'reported' }, { where: { id: review.id } });
    await sequelize.query(
      `INSERT INTO reports (review_id, reporter_id, reason) VALUES (:r, :u, 'spam')`,
      {
        replacements: { r: review.id, u: reporter.user.id },
      }
    );
    expect((await agent.delete(`/api/reviews/${review.id}`)).status).toBe(204);
    expect((await sequelize.query('SELECT 1 FROM reports'))[0]).toHaveLength(0);
  });

  test('guests get 401; unknown and impossible ids get 404; deleting twice is a 404 the second time', async () => {
    const { agent, review } = await posted();
    expect((await request(app).delete(`/api/reviews/${review.id}`)).status).toBe(401);
    expect((await agent.delete(`/api/reviews/${review.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/reviews/${review.id}`)).status).toBe(404);
    for (const id of ['abc', 0, 2147483648])
      expect((await agent.delete(`/api/reviews/${id}`)).status).toBe(404);
  });
});

describe('Achievement badges (FR#16)', () => {
  const venues = async (n) => Promise.all(Array.from({ length: n }, () => createVenue()));

  test('badges are awarded at 1, 5, 10 and 25 reviews, and announced in the response', async () => {
    await seedAchievements();
    const { agent, user } = await loginAs(app);
    const list = await venues(25);
    const announced = {};
    for (const [i, venue] of list.entries()) {
      const res = await post(agent, venue.id, { rating: 4 });
      expect(res.status).toBe(201);
      announced[i + 1] = res.body.newAchievements.map((a) => a.name);
    }
    expect(announced[1]).toEqual(['First Bite']);
    expect(announced[2]).toEqual([]);
    expect(announced[4]).toEqual([]);
    expect(announced[5]).toEqual(['Taste Tester']);
    expect(announced[9]).toEqual([]);
    expect(announced[10]).toEqual(['Campus Critic']);
    expect(announced[24]).toEqual([]);
    expect(announced[25]).toEqual(['Head Critic']);
    expect(await UserAchievement.count({ where: { user_id: user.id } })).toBe(4);
  });

  test('an announced badge has an id, name, threshold and date', async () => {
    await seedAchievements();
    const { agent } = await loginAs(app);
    const [venue] = await venues(1);
    const { newAchievements } = (await post(agent, venue.id, { rating: 4 })).body;
    expect(newAchievements).toEqual([
      {
        id: expect.any(Number),
        name: 'First Bite',
        reviewThreshold: 1,
        earnedAt: expect.any(String),
      },
    ]);
  });

  test('a badge is never awarded twice', async () => {
    await seedAchievements();
    const { agent, user } = await loginAs(app);
    const [v1, v2] = await venues(2);
    await post(agent, v1.id, { rating: 4 });
    const second = await post(agent, v2.id, { rating: 4 });
    expect(second.body.newAchievements).toEqual([]);
    expect(await UserAchievement.count({ where: { user_id: user.id } })).toBe(1);
  });

  test('only publicly visible reviews count toward a badge', async () => {
    await seedAchievements();
    const { agent, user } = await loginAs(app);
    const list = await venues(5);
    for (const [i, status] of ['published', 'reported', 'flagged', 'removed'].entries()) {
      await createReview({ user, venue: list[i], status });
    }
    // 2 visible so far; this makes 3. Not yet 5.
    const res = await post(agent, list[4].id, { rating: 5 });
    expect(res.body.newAchievements.map((a) => a.name)).toEqual(['First Bite']); // earned now: first visible count >= 1
    const [{ count }] = (
      await sequelize.query('SELECT COUNT(*)::int AS count FROM user_achievements')
    )[0];
    expect(count).toBe(1);
  });

  test('deleting reviews does not take badges away', async () => {
    await seedAchievements();
    const { agent, user } = await loginAs(app);
    const [venue] = await venues(1);
    const res = await post(agent, venue.id, { rating: 4 });
    await agent.delete(`/api/reviews/${res.body.review.id}`);
    expect(await UserAchievement.count({ where: { user_id: user.id } })).toBe(1);
  });

  test('students earn badges independently', async () => {
    await seedAchievements();
    const a = await loginAs(app, { username: 'badge_a' });
    const b = await loginAs(app, { username: 'badge_b' });
    const [venue] = await venues(1);
    await post(a.agent, venue.id, { rating: 4 });
    expect(await UserAchievement.count({ where: { user_id: a.user.id } })).toBe(1);
    expect(await UserAchievement.count({ where: { user_id: b.user.id } })).toBe(0);
  });
});
