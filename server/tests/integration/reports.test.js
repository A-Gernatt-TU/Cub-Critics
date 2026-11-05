// Reporting reviews (FR#31).
const request = require('supertest');
const app = require('../../app');
const { Review, Report } = require('../../models');
const { resetDb, closeAll, loginAs, createUser, createVenue, createReview } = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const report = (agent, reviewId, body) => agent.post(`/api/reviews/${reviewId}/report`).send(body);
const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;

async function aReview(overrides = {}) {
  const author = await createUser({ username: `author_${Math.random().toString(36).slice(2, 8)}` });
  const venue = await createVenue();
  const review = await createReview({
    user: author.user,
    venue,
    rating: 1,
    body: 'rude text',
    ...overrides,
  });
  return { author, venue, review };
}

describe('GET /api/reviews/report-reasons', () => {
  test('lists the reasons for the report form, for anyone', async () => {
    const res = await request(app).get('/api/reviews/report-reasons');
    expect(res.status).toBe(200);
    expect(res.body.reasons).toEqual([
      { value: 'harassment', label: 'Harassment' },
      { value: 'hate_speech', label: 'Hate speech' },
      { value: 'threats', label: 'Threats' },
      { value: 'personal_info', label: 'Personal information' },
      { value: 'spam', label: 'Spam' },
      { value: 'other', label: 'Other' },
    ]);
  });
});

describe('POST /api/reviews/:id/report', () => {
  test("a student reports another student's review: the report is stored and the review is marked reported", async () => {
    const { review } = await aReview();
    const me = await loginAs(app, { username: 'reporter_1' });
    const res = await report(me.agent, review.id, {
      reason: 'harassment',
      comment: 'Targets a staff member',
    });

    expect(res.status).toBe(201);
    expect(res.body.report).toEqual({
      id: expect.any(Number),
      reason: 'harassment',
      createdAt: expect.any(String),
    });
    const stored = await Report.findOne({ where: { review_id: review.id } });
    expect(stored).toMatchObject({
      reporter_id: me.user.id,
      reason: 'harassment',
      comment: 'Targets a staff member',
      status: 'open',
      closed_at: null,
    });
    expect((await Review.findByPk(review.id)).status).toBe('reported');
  });

  test('the comment is optional', async () => {
    const { review } = await aReview();
    const me = await loginAs(app);
    expect((await report(me.agent, review.id, { reason: 'spam' })).status).toBe(201);
    expect((await Report.findOne()).comment).toBeNull();
  });

  test('a reported review stays visible until a moderator decides (FR#42)', async () => {
    const { review, venue } = await aReview();
    const me = await loginAs(app);
    await report(me.agent, review.id, { reason: 'spam' });
    const list = (await request(app).get(`/api/venues/${venue.id}/reviews`)).body;
    expect(list.reviews.map((r) => r.id)).toEqual([review.id]);
  });

  test('several students can report the same review; it stays "reported"', async () => {
    const { review } = await aReview();
    for (const name of ['reporter_a', 'reporter_b', 'reporter_c']) {
      const me = await loginAs(app, { username: name });
      expect((await report(me.agent, review.id, { reason: 'spam' })).status).toBe(201);
    }
    expect(await Report.count()).toBe(3);
    expect((await Review.findByPk(review.id)).status).toBe('reported');
  });

  test('reporting the same review twice is refused', async () => {
    const { review } = await aReview();
    const me = await loginAs(app);
    await report(me.agent, review.id, { reason: 'spam' });
    const again = await report(me.agent, review.id, { reason: 'threats' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REPORT_ALREADY_FILED');
    expect(await Report.count()).toBe(1);
  });

  test('a double-click (simultaneous submissions) files exactly one report', async () => {
    const { review } = await aReview();
    const me = await loginAs(app);
    const results = await Promise.all(
      [1, 2, 3].map(() => report(me.agent, review.id, { reason: 'spam' }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await Report.count()).toBe(1);
  });

  test('you cannot report your own review', async () => {
    const me = await loginAs(app, { username: 'self_reporter' });
    const venue = await createVenue();
    const review = await createReview({ user: me.user, venue });
    const res = await report(me.agent, review.id, { reason: 'spam' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_REPORT_OWN_REVIEW');
    expect(await Report.count()).toBe(0);
    expect((await Review.findByPk(review.id)).status).toBe('published');
  });

  test('a reason is required and must be one of the listed ones, with the message beside the field', async () => {
    const { review } = await aReview();
    const me = await loginAs(app);
    for (const body of [
      {},
      { reason: '' },
      { reason: 'because' },
      { reason: null },
      { reason: 5 },
      { comment: 'only a comment' },
    ]) {
      const res = await report(me.agent, review.id, body);
      expect(res.status).toBe(400);
      expect(field(res, 'reason')).toBe('Please choose a reason for your report');
    }
    expect(await Report.count()).toBe(0);
  });

  test('the comment is limited to 500 characters and cannot hide control characters', async () => {
    const { review } = await aReview();
    const me = await loginAs(app);
    expect(
      field(
        await report(me.agent, review.id, { reason: 'other', comment: 'x'.repeat(501) }),
        'comment'
      )
    ).toBe('Comment must be 500 characters or fewer');
    expect(
      (await report(me.agent, review.id, { reason: 'other', comment: 'a\u0000b' })).status
    ).toBe(400);
    expect(
      (await report(me.agent, review.id, { reason: 'other', comment: 'x'.repeat(500) })).status
    ).toBe(201);
  });

  test('a review a moderator already hid or removed looks like it does not exist', async () => {
    const me = await loginAs(app);
    for (const status of ['flagged', 'removed']) {
      const { review } = await aReview({ status });
      expect((await report(me.agent, review.id, { reason: 'spam' })).status).toBe(404);
    }
    expect(await Report.count()).toBe(0);
  });

  test('guests cannot report (401); unknown and impossible ids are 404', async () => {
    const { review } = await aReview();
    expect(
      (await request(app).post(`/api/reviews/${review.id}/report`).send({ reason: 'spam' })).status
    ).toBe(401);
    const me = await loginAs(app);
    for (const id of [424242, 'abc', 0, 2147483648])
      expect((await report(me.agent, id, { reason: 'spam' })).status).toBe(404);
  });

  test('extra fields cannot set the reporter, status or review', async () => {
    const { review } = await aReview();
    const other = await createUser();
    const me = await loginAs(app, { username: 'sneaky' });
    await report(me.agent, review.id, {
      reason: 'spam',
      reporter_id: other.user.id,
      status: 'closed',
      review_id: 999,
    });
    expect(await Report.findOne()).toMatchObject({
      reporter_id: me.user.id,
      status: 'open',
      review_id: review.id,
    });
  });

  test('administrators can report reviews too', async () => {
    const { review } = await aReview();
    const admin = await loginAs(app, { role: 'administrator', username: 'admin_reporter' });
    expect((await report(admin.agent, review.id, { reason: 'spam' })).status).toBe(201);
  });
});
