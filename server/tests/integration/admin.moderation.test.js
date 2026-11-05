// Moderation: dashboard, queue, approve / flag / remove (FR#40-FR#44, FR#59, SF#2, AL#1, DR#2).
const request = require('supertest');
const app = require('../../app');
const { Review, Report, ModerationLog } = require('../../models');
const {
  resetDb,
  closeAll,
  loginAs,
  createUser,
  createVenue,
  createReview,
  sequelize,
} = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;
const decide = (agent, id, action, body = {}) =>
  agent.post(`/api/admin/reviews/${id}/${action}`).send(body);
const publicReviews = async (venueId) =>
  (await request(app).get(`/api/venues/${venueId}/reviews`)).body;

async function setup() {
  const admin = await loginAs(app, {
    role: 'administrator',
    username: 'mod_admin',
    email: 'mod.admin@example.com',
  });
  const author = await createUser({ username: 'review_author', email: 'author@example.com' });
  const venue = await createVenue({ name: 'Moderated Venue' });
  return { admin, author, venue };
}

async function reportedReview(
  { author, venue },
  { reports = 1, body = 'a rude review', rating = 1 } = {}
) {
  const review = await createReview({ user: author.user, venue, rating, body, status: 'reported' });
  for (let i = 0; i < reports; i += 1) {
    const reporter = await createUser({
      username: `reporter_${review.id}_${i}`,
      email: `reporter${review.id}_${i}@example.com`,
    });
    await Report.create({
      review_id: review.id,
      reporter_id: reporter.user.id,
      reason: 'harassment',
      comment: `comment ${i}`,
    });
  }
  return review;
}

describe('GET /api/admin/dashboard (FR#40)', () => {
  test('shows how many reviews await moderation, plus venue and report counts', async () => {
    const ctx = await setup();
    await reportedReview(ctx, { reports: 2 });
    const second = await createUser({ username: 'second_author', email: 'second@example.com' });
    await reportedReview({ ...ctx, author: second }, { reports: 1 });
    const third = await createUser({ username: 'third_author', email: 'third@example.com' });
    await createReview({ user: third.user, venue: ctx.venue, status: 'flagged' });
    const fourth = await createUser({ username: 'fourth_author', email: 'fourth@example.com' });
    await createReview({ user: fourth.user, venue: ctx.venue, status: 'published' }); // not awaiting
    await createVenue({ status: 'inactive' });

    const res = await ctx.admin.agent.get('/api/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.dashboard).toEqual({
      awaitingModeration: 3,
      reportedReviews: 2,
      flaggedReviews: 1,
      openReports: 3,
      venues: { active: 1, inactive: 1 },
    });
  });

  test('all zeros on a quiet site', async () => {
    const { admin } = await setup();
    expect((await admin.agent.get('/api/admin/dashboard')).body.dashboard).toEqual({
      awaitingModeration: 0,
      reportedReviews: 0,
      flaggedReviews: 0,
      openReports: 0,
      venues: { active: 1, inactive: 0 }, // the one venue the test setup creates
    });
  });
});

describe('GET /api/admin/moderation/queue (FR#41)', () => {
  test('lists reported and flagged reviews with text, author, venue, and each open report', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { reports: 2, body: 'the offending text' });
    const res = await ctx.admin.agent.get('/api/admin/moderation/queue');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const [item] = res.body.items;
    expect(item.review).toEqual({
      id: review.id,
      rating: 1,
      body: 'the offending text',
      status: 'reported',
      createdAt: expect.any(String),
      edited: false,
      editedAt: null,
      author: { id: ctx.author.user.id, username: 'review_author' },
      venue: { id: ctx.venue.id, name: 'Moderated Venue' },
    });
    expect(item.reports).toHaveLength(2);
    expect(item.reports[0]).toEqual({
      id: expect.any(Number),
      reason: 'harassment',
      reasonLabel: 'Harassment',
      comment: 'comment 0',
      createdAt: expect.any(String),
      reporter: { id: expect.any(Number), username: expect.stringMatching(/^reporter_/) },
    });
  });

  test("never exposes anyone's email or login details", async () => {
    const ctx = await setup();
    await reportedReview(ctx);
    const text = JSON.stringify((await ctx.admin.agent.get('/api/admin/moderation/queue')).body);
    expect(text).not.toMatch(/@example\.com|password|hash|tos_/i);
  });

  test('does not list ordinary or removed reviews; flagged ones with no reports are listed with an empty report list', async () => {
    const ctx = await setup();
    const others = [];
    for (let i = 0; i < 3; i += 1)
      others.push(await createUser({ username: `other_${i}`, email: `o${i}@example.com` }));
    await createReview({ user: others[0].user, venue: ctx.venue, status: 'published' });
    await createReview({ user: others[1].user, venue: ctx.venue, status: 'removed' });
    const flagged = await createReview({
      user: others[2].user,
      venue: ctx.venue,
      status: 'flagged',
    });

    const res = await ctx.admin.agent.get('/api/admin/moderation/queue');
    expect(res.body.items.map((i) => i.review.id)).toEqual([flagged.id]);
    expect(res.body.items[0].reports).toEqual([]);
  });

  test('closed reports are not shown', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { reports: 2 });
    // Close exactly one of the two reports (an UPDATE cannot be limited to one row).
    const [first] = await Report.findAll({
      where: { review_id: review.id },
      order: [['id', 'ASC']],
    });
    await first.update({ status: 'closed', closed_at: new Date() });
    const [item] = (await ctx.admin.agent.get('/api/admin/moderation/queue')).body.items;
    expect(item.reports).toHaveLength(1);
  });

  test('the review reported longest ago comes first', async () => {
    const ctx = await setup();
    const make = async (name, reportedAt) => {
      const author = await createUser({ username: name, email: `${name}@example.com` });
      const review = await createReview({
        user: author.user,
        venue: ctx.venue,
        status: 'reported',
        body: name,
      });
      const reporter = await createUser({
        username: `rep_${name}`,
        email: `rep_${name}@example.com`,
      });
      await Report.create({
        review_id: review.id,
        reporter_id: reporter.user.id,
        reason: 'spam',
        created_at: reportedAt,
      });
      return review;
    };
    await make('newest', new Date('2026-10-30T12:00:00Z'));
    await make('oldest', new Date('2026-10-01T12:00:00Z'));
    await make('middle', new Date('2026-10-15T12:00:00Z'));
    const items = (await ctx.admin.agent.get('/api/admin/moderation/queue')).body.items;
    expect(items.map((i) => i.review.body)).toEqual(['oldest', 'middle', 'newest']);
  });

  test('filter by status, and page through with the total', async () => {
    const ctx = await setup();
    for (let i = 0; i < 3; i += 1) {
      const a = await createUser({ username: `rep_author_${i}`, email: `ra${i}@example.com` });
      await reportedReview({ ...ctx, author: a });
    }
    const f = await createUser({ username: 'flag_author', email: 'fa@example.com' });
    await createReview({ user: f.user, venue: ctx.venue, status: 'flagged' });

    const get = async (qs) => (await ctx.admin.agent.get(`/api/admin/moderation/queue${qs}`)).body;
    expect((await get('?status=flagged')).total).toBe(1);
    expect((await get('?status=reported')).total).toBe(3);
    expect((await get('')).total).toBe(4);
    const page = await get('?limit=2&offset=2');
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  test('bad query values are a 400', async () => {
    const { admin } = await setup();
    for (const qs of ['status=removed', 'limit=0', 'limit=51', 'offset=-1']) {
      expect((await admin.agent.get(`/api/admin/moderation/queue?${qs}`)).status).toBe(400);
    }
  });
});

describe('approve (FR#42)', () => {
  test('keeps the review published and closes its open reports; the decision is logged', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { reports: 2, body: 'actually fine', rating: 4 });
    const res = await decide(ctx.admin.agent, review.id, 'approve', { reason: 'Not a violation' });

    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ id: review.id, status: 'published' });
    expect((await Review.findByPk(review.id)).status).toBe('published');
    const reports = await Report.findAll({ where: { review_id: review.id } });
    expect(reports.every((r) => r.status === 'closed' && r.closed_at)).toBe(true);

    const [log] = await ModerationLog.findAll();
    expect(log).toMatchObject({
      admin_id: ctx.admin.user.id,
      review_id: review.id,
      action: 'approve',
      reason: 'Not a violation',
      review_author_id: ctx.author.user.id,
      review_venue_id: ctx.venue.id,
      review_rating: 4,
      review_text: 'actually fine',
    });
    expect(log.created_at).toBeInstanceOf(Date);
  });

  test('the reason is optional', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    expect((await decide(ctx.admin.agent, review.id, 'approve')).status).toBe(200);
    expect((await ModerationLog.findOne()).reason).toBeNull();
  });

  test('also restores a flagged review', async () => {
    const ctx = await setup();
    const review = await createReview({
      user: ctx.author.user,
      venue: ctx.venue,
      status: 'flagged',
    });
    expect((await decide(ctx.admin.agent, review.id, 'approve')).status).toBe(200);
    expect((await publicReviews(ctx.venue.id)).total).toBe(1);
  });

  test('a review that was not reported or flagged, or is removed, cannot be approved', async () => {
    const ctx = await setup();
    for (const status of ['published', 'removed']) {
      const a = await createUser({ username: `a_${status}`, email: `a_${status}@example.com` });
      const review = await createReview({ user: a.user, venue: ctx.venue, status });
      const res = await decide(ctx.admin.agent, review.id, 'approve');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'REVIEW_NOT_ACTIONABLE', details: { status } });
    }
    expect(await ModerationLog.count()).toBe(0);
  });
});

describe('flag (FR#43, SF#2)', () => {
  test('hides the review from the public immediately, and from the venue average', async () => {
    const ctx = await setup();
    const review = await createReview({
      user: ctx.author.user,
      venue: ctx.venue,
      rating: 1,
      status: 'published',
    });
    const other = await createUser({ username: 'happy_one', email: 'happy@example.com' });
    await createReview({ user: other.user, venue: ctx.venue, rating: 5 });
    expect((await publicReviews(ctx.venue.id)).total).toBe(2);

    const res = await decide(ctx.admin.agent, review.id, 'flag', {
      reason: 'Suspected hate speech',
    });
    expect(res.status).toBe(200);
    expect(res.body.review.status).toBe('flagged');

    const visible = await publicReviews(ctx.venue.id);
    expect(visible.total).toBe(1);
    expect(visible.reviews.map((r) => r.id)).not.toContain(review.id);
    const venue = (await request(app).get(`/api/venues/${ctx.venue.id}`)).body.venue;
    expect(venue).toMatchObject({ avgRating: 5, reviewCount: 1 });
  });

  test('works on a reported review, whose reports stay open until the final decision', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { reports: 2 });
    await decide(ctx.admin.agent, review.id, 'flag');
    expect((await Review.findByPk(review.id)).status).toBe('flagged');
    expect(await Report.count({ where: { review_id: review.id, status: 'open' } })).toBe(2);
    expect((await ModerationLog.findOne()).action).toBe('flag');
  });

  test('cannot flag what is already flagged or removed', async () => {
    const ctx = await setup();
    for (const status of ['flagged', 'removed']) {
      const a = await createUser({ username: `f_${status}`, email: `f_${status}@example.com` });
      const review = await createReview({ user: a.user, venue: ctx.venue, status });
      expect((await decide(ctx.admin.agent, review.id, 'flag')).status).toBe(409);
    }
  });

  test('a flagged review is still in the queue until a decision is made', async () => {
    const ctx = await setup();
    const review = await createReview({ user: ctx.author.user, venue: ctx.venue });
    await decide(ctx.admin.agent, review.id, 'flag');
    const queue = (await ctx.admin.agent.get('/api/admin/moderation/queue')).body;
    expect(queue.items.map((i) => i.review.id)).toEqual([review.id]);
  });
});

describe('remove (FR#44, DR#2)', () => {
  test('requires a reason', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
      const res = await decide(ctx.admin.agent, review.id, 'remove', body);
      expect(res.status).toBe(400);
      expect(field(res, 'reason')).toMatch(/required/i);
    }
    expect((await Review.findByPk(review.id)).status).toBe('reported');
    expect(await ModerationLog.count()).toBe(0);
  });

  test('removes the review, closes its reports, and records who removed it and why', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { reports: 2, body: 'terrible words' });
    const res = await decide(ctx.admin.agent, review.id, 'remove', {
      reason: 'Harassment of a named person',
    });

    expect(res.status).toBe(200);
    expect(res.body.review.status).toBe('removed');
    expect((await publicReviews(ctx.venue.id)).total).toBe(0);
    expect(await Report.count({ where: { review_id: review.id, status: 'open' } })).toBe(0);

    const [log] = await ModerationLog.findAll();
    expect(log).toMatchObject({
      admin_id: ctx.admin.user.id,
      action: 'remove',
      reason: 'Harassment of a named person',
      review_text: 'terrible words',
    });
  });

  test('the removed review is kept, not deleted (retained for 12 months, DR#2)', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    await decide(ctx.admin.agent, review.id, 'remove', { reason: 'x' });
    expect(await Review.findByPk(review.id)).not.toBeNull();
  });

  test('works from published and flagged states too', async () => {
    const ctx = await setup();
    for (const status of ['published', 'flagged']) {
      const a = await createUser({ username: `r_${status}`, email: `r_${status}@example.com` });
      const review = await createReview({ user: a.user, venue: ctx.venue, status });
      expect(
        (await decide(ctx.admin.agent, review.id, 'remove', { reason: 'reason' })).status
      ).toBe(200);
    }
  });

  test('the author can neither delete it nor post a replacement', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    await decide(ctx.admin.agent, review.id, 'remove', { reason: 'rule violation' });
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: ctx.author.user.email, password: ctx.author.password });
    expect((await agent.delete(`/api/reviews/${review.id}`)).body.error.code).toBe('REVIEW_LOCKED');
    expect(
      (await agent.post(`/api/venues/${ctx.venue.id}/reviews`).send({ rating: 5 })).body.error.code
    ).toBe('REVIEW_REMOVED');
  });

  test('cannot remove twice', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    await decide(ctx.admin.agent, review.id, 'remove', { reason: 'x' });
    expect((await decide(ctx.admin.agent, review.id, 'remove', { reason: 'again' })).status).toBe(
      409
    );
    expect(await ModerationLog.count()).toBe(1);
  });

  test('the reason is limited to 500 characters and must be clean text', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    expect(
      field(
        await decide(ctx.admin.agent, review.id, 'remove', { reason: 'x'.repeat(501) }),
        'reason'
      )
    ).toBe('Reason must be 500 characters or fewer');
    expect(
      (await decide(ctx.admin.agent, review.id, 'remove', { reason: 'a\u0000b' })).status
    ).toBe(400);
  });
});

describe('integrity of decisions', () => {
  test('the log keeps its record if the author later deletes an approved review', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx, { body: 'kept in the log' });
    await decide(ctx.admin.agent, review.id, 'approve');
    const authorAgent = request.agent(app);
    await authorAgent
      .post('/api/auth/login')
      .send({ email: ctx.author.user.email, password: ctx.author.password });
    expect((await authorAgent.delete(`/api/reviews/${review.id}`)).status).toBe(204);

    const [log] = await ModerationLog.findAll();
    expect(log.review_id).toBeNull();
    expect(log.review_text).toBe('kept in the log');
    expect(log.admin_id).toBe(ctx.admin.user.id);
  });

  test('two administrators acting at the same moment: one succeeds, the other is told, and only one log entry', async () => {
    const ctx = await setup();
    const second = await loginAs(app, {
      role: 'administrator',
      username: 'second_admin',
      email: 'second.admin@example.com',
    });
    const review = await reportedReview(ctx);
    const results = await Promise.all([
      decide(ctx.admin.agent, review.id, 'remove', { reason: 'first' }),
      decide(second.agent, review.id, 'remove', { reason: 'second' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ModerationLog.count()).toBe(1);
  });

  test('a decision and its log entry stand or fall together', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    await sequelize.query('ALTER TABLE moderation_log RENAME TO moderation_log_hidden');
    try {
      const res = await decide(ctx.admin.agent, review.id, 'remove', { reason: 'will fail' });
      expect(res.status).toBe(500);
    } finally {
      await sequelize.query('ALTER TABLE moderation_log_hidden RENAME TO moderation_log');
    }
    // No log entry could be written, so the review must NOT have been removed.
    expect((await Review.findByPk(review.id)).status).toBe('reported');
    expect(await Report.count({ where: { review_id: review.id, status: 'open' } })).toBe(1);
  });

  test('unknown and impossible review ids are 404, and nothing is logged', async () => {
    const { admin } = await setup();
    for (const action of ['approve', 'flag']) {
      for (const id of [424242, 'abc', 0, 2147483648])
        expect((await decide(admin.agent, id, action)).status).toBe(404);
    }
    expect((await decide(admin.agent, 424242, 'remove', { reason: 'x' })).status).toBe(404);
    expect(await ModerationLog.count()).toBe(0);
  });

  test('a decision cannot be forced from another website', async () => {
    const ctx = await setup();
    const review = await reportedReview(ctx);
    const res = await ctx.admin.agent
      .post(`/api/admin/reviews/${review.id}/remove`)
      .set('Origin', 'https://evil.example')
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect((await Review.findByPk(review.id)).status).toBe('reported');
  });
});
