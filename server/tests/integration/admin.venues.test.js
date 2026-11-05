// Administrator venue management (FR#45, FR#46, FR#47, AL#2).
const request = require('supertest');
const app = require('../../app');
const { Venue, VenueHour, VenueSpecialHour, Review } = require('../../models');
const {
  resetDb,
  closeAll,
  loginAs,
  createUser,
  createCategory,
  createVenue,
  createReview,
  sequelize,
} = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;
const names = (res) => res.body.venues.map((v) => v.name);
const auditRows = async () => (await sequelize.query('SELECT * FROM audit_log ORDER BY id'))[0];

async function setup() {
  const admin = await loginAs(app, {
    role: 'administrator',
    username: 'venue_admin',
    email: 'venue.admin@example.com',
  });
  const category = await createCategory('Café');
  return { admin, category };
}

const validVenue = (category, overrides = {}) => ({
  name: 'Paws Café',
  categoryId: category.id,
  description: 'Coffee and pastries.',
  location: 'Library, ground floor',
  hours: [
    { dayOfWeek: 1, opensAt: '07:00', closesAt: '20:00' },
    { dayOfWeek: 2, opensAt: '07:00', closesAt: '20:00' },
    { dayOfWeek: 0, isClosed: true },
  ],
  ...overrides,
});

describe('POST /api/admin/venues (FR#45)', () => {
  test('creates a venue with its details and hours, and it is live straight away', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent.post('/api/admin/venues').send(validVenue(category));

    expect(res.status).toBe(201);
    const venue = res.body.venue;
    expect(venue).toMatchObject({
      name: 'Paws Café',
      description: 'Coffee and pastries.',
      location: 'Library, ground floor',
      category: { id: category.id, name: 'Café' },
      status: 'active',
      avgRating: null,
      reviewCount: 0,
      photos: [],
    });
    expect(venue.hours[1].periods).toEqual([{ opensAt: '07:00', closesAt: '20:00' }]);
    expect(venue.hours[0].isClosed).toBe(true);
    expect(venue.hours[3].isClosed).toBe(true); // a day with no entry is closed
    expect(venue.menu.items).toEqual([]);

    // visible to the public at once
    expect(names(await request(app).get('/api/venues'))).toEqual(['Paws Café']);
    expect((await request(app).get(`/api/venues/${venue.id}`)).status).toBe(200);
  });

  test('accepts split hours, overnight hours and holiday hours', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent.post('/api/admin/venues').send(
      validVenue(category, {
        hours: [
          { dayOfWeek: 1, opensAt: '11:00', closesAt: '14:00' },
          { dayOfWeek: 1, opensAt: '17:00', closesAt: '20:00' },
          { dayOfWeek: 5, opensAt: '18:00', closesAt: '02:00' },
        ],
        specialHours: [
          { date: '2099-11-26', isClosed: true, note: 'Thanksgiving' },
          { date: '2099-12-24', opensAt: '09:00', closesAt: '13:00' },
        ],
      })
    );
    expect(res.status).toBe(201);
    expect(res.body.venue.hours[1].periods).toHaveLength(2);
    expect(res.body.venue.hours[5].periods).toEqual([{ opensAt: '18:00', closesAt: '02:00' }]);
    expect(res.body.venue.specialHours).toEqual([
      { date: '2099-11-26', note: 'Thanksgiving', isClosed: true, periods: [] },
      {
        date: '2099-12-24',
        note: null,
        isClosed: false,
        periods: [{ opensAt: '09:00', closesAt: '13:00' }],
      },
    ]);
  });

  test('administrators see every upcoming holiday date; the public page shows only the next 60 days', async () => {
    const { admin, category } = await setup();
    const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const venue = await createVenue({
      category,
      special: [
        { date: inDays(10), is_closed: true, note: 'Soon' },
        { date: inDays(200), is_closed: true, note: 'Far away' },
      ],
    });
    const adminView = (await admin.agent.get(`/api/admin/venues/${venue.id}`)).body.venue;
    expect(adminView.specialHours.map((h) => h.note)).toEqual(['Soon', 'Far away']);
    const publicView = (await request(app).get(`/api/venues/${venue.id}`)).body.venue;
    expect(publicView.specialHours.map((h) => h.note)).toEqual(['Soon']);
  });

  test('saving a venue with the special hours it was loaded with keeps them all (no accidental deletion)', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({
      category,
      special: [{ date: '2099-11-26', is_closed: true, note: 'Thanksgiving' }],
    });
    const loaded = (await admin.agent.get(`/api/admin/venues/${venue.id}`)).body.venue;
    await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({
      name: 'Renamed',
      specialHours: loaded.specialHours.map((h) => ({
        date: h.date,
        isClosed: h.isClosed,
        note: h.note,
      })),
    });
    expect(await VenueSpecialHour.count({ where: { venue_id: venue.id } })).toBe(1);
  });

  test('text is trimmed and cleaned; two venues may share a name (different locations)', async () => {
    const { admin, category } = await setup();
    await admin.agent
      .post('/api/admin/venues')
      .send(validVenue(category, { name: '  Starbucks  ', location: 'Library' }));
    const res = await admin.agent
      .post('/api/admin/venues')
      .send(validVenue(category, { name: 'Starbucks', location: 'Union' }));
    expect(res.status).toBe(201);
    expect(await Venue.count({ where: { name: 'Starbucks' } })).toBe(2);
  });

  test('every missing field is reported at once, beside its field', async () => {
    const { admin } = await setup();
    const res = await admin.agent.post('/api/admin/venues').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual([
      'categoryId',
      'description',
      'hours',
      'location',
      'name',
    ]);
    expect(field(res, 'name')).toBe('Name is required');
    expect(field(res, 'categoryId')).toBe('Category is required');
  });

  test('a category that does not exist is refused and nothing is created', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent
      .post('/api/admin/venues')
      .send(validVenue(category, { categoryId: 999999 }));
    expect(res.status).toBe(400);
    expect(field(res, 'categoryId')).toBe('That category does not exist');
    expect(await Venue.count()).toBe(0);
    expect(await VenueHour.count()).toBe(0);
  });

  test.each([
    [
      'overlapping periods',
      [
        { dayOfWeek: 1, opensAt: '11:00', closesAt: '14:00' },
        { dayOfWeek: 1, opensAt: '13:00', closesAt: '15:00' },
      ],
    ],
    [
      'closed and open on one day',
      [
        { dayOfWeek: 1, isClosed: true },
        { dayOfWeek: 1, opensAt: '09:00', closesAt: '10:00' },
      ],
    ],
    ['a bad time', [{ dayOfWeek: 1, opensAt: '7:00', closesAt: '20:00' }]],
    ['an impossible hour', [{ dayOfWeek: 1, opensAt: '07:00', closesAt: '24:30' }]],
    ['a missing closing time', [{ dayOfWeek: 1, opensAt: '07:00' }]],
    ['times on a closed day', [{ dayOfWeek: 1, isClosed: true, opensAt: '07:00' }]],
    ['a day out of range', [{ dayOfWeek: 7, opensAt: '07:00', closesAt: '08:00' }]],
    ['no hours at all', []],
    ['hours that are not a list', 'always open'],
    ['junk entries', [null, 5, 'x']],
  ])('refuses %s with a clear 400, never a server error', async (_label, hours) => {
    const { admin, category } = await setup();
    const res = await admin.agent.post('/api/admin/venues').send(validVenue(category, { hours }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field.startsWith('hours'))).toBe(true);
    expect(await Venue.count()).toBe(0);
  });

  test('bad holiday dates are refused', async () => {
    const { admin, category } = await setup();
    for (const specialHours of [
      [{ date: '2026-02-30', isClosed: true }],
      [{ date: 'tomorrow', isClosed: true }],
      [{ date: '2026-11-26' }],
    ]) {
      const res = await admin.agent
        .post('/api/admin/venues')
        .send(validVenue(category, { specialHours }));
      expect(res.status).toBe(400);
      expect(res.body.error.details.some((d) => d.field.startsWith('specialHours'))).toBe(true);
    }
  });

  test('text limits and unsafe characters are refused', async () => {
    const { admin, category } = await setup();
    const cases = [
      [{ name: 'x'.repeat(101) }, 'name'],
      [{ description: 'x'.repeat(1001) }, 'description'],
      [{ location: 'x'.repeat(101) }, 'location'],
      [{ name: 'a\u0007b' }, 'name'],
      [{ name: '   ' }, 'name'],
      [{ description: 'a\u202Eb' }, 'description'],
    ];
    for (const [overrides, name] of cases) {
      const res = await admin.agent.post('/api/admin/venues').send(validVenue(category, overrides));
      expect(res.status).toBe(400);
      expect(field(res, name)).toBeTruthy();
    }
  });

  test('extra fields cannot set the status or id', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent
      .post('/api/admin/venues')
      .send(validVenue(category, { status: 'inactive', id: 999 }));
    expect(res.body.venue.status).toBe('active');
    expect(res.body.venue.id).not.toBe(999);
  });

  test('is recorded in the audit log with who, what, when and from where (AL#2)', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent.post('/api/admin/venues').send(validVenue(category));
    const rows = (await auditRows()).filter((r) => r.event_type === 'venue_created');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: admin.user.id,
      entity_type: 'venue',
      entity_id: res.body.venue.id,
      details: { name: 'Paws Café' },
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].ip_address).toBeTruthy();
  });

  test('a failure leaves no half-built venue and no audit entry', async () => {
    const { admin, category } = await setup();
    await sequelize.query('ALTER TABLE audit_log RENAME TO audit_log_hidden');
    try {
      const res = await admin.agent.post('/api/admin/venues').send(validVenue(category));
      expect(res.status).toBe(500);
    } finally {
      await sequelize.query('ALTER TABLE audit_log_hidden RENAME TO audit_log');
    }
    // The change must not exist without its audit entry (AL#2).
    expect(await Venue.count()).toBe(0);
    expect(await VenueHour.count()).toBe(0);
  });
});

describe('GET /api/admin/venues', () => {
  test('lists every venue including deactivated ones, with the counts an admin needs', async () => {
    const { admin, category } = await setup();
    const a = await createVenue({
      name: 'Alpha',
      category,
      hours: 'always',
      menu: ['Soup', 'Salad'],
      photos: ['venue-photos/11111111-1111-4111-8111-111111111111.png'],
    });
    await createVenue({ name: 'bravo', category, status: 'inactive' });
    const { user } = await createUser();
    await createReview({ user, venue: a, rating: 4 });

    const res = await admin.agent.get('/api/admin/venues');
    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([
      {
        id: a.id,
        name: 'Alpha',
        status: 'active',
        location: 'Student Union',
        category: { id: category.id, name: 'Café' },
        avgRating: 4,
        reviewCount: 1,
        menuItemCount: 2,
        photoCount: 1,
        hasHours: true,
      },
      {
        id: expect.any(Number),
        name: 'bravo',
        status: 'inactive',
        location: 'Student Union',
        category: { id: category.id, name: 'Café' },
        avgRating: null,
        reviewCount: 0,
        menuItemCount: 0,
        photoCount: 0,
        hasHours: false,
      },
    ]);
  });

  test('GET /api/admin/venues/:id works for a deactivated venue and shows its status', async () => {
    const { admin } = await setup();
    const venue = await createVenue({ status: 'inactive' });
    const res = await admin.agent.get(`/api/admin/venues/${venue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.venue.status).toBe('inactive');
    expect((await request(app).get(`/api/venues/${venue.id}`)).status).toBe(404); // the public still cannot
    expect((await admin.agent.get('/api/admin/venues/424242')).status).toBe(404);
  });
});

describe('PATCH /api/admin/venues/:id (FR#46)', () => {
  test('changes only what was sent', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({
      name: 'Old Name',
      category,
      description: 'Old description',
      location: 'Old place',
      hours: [[1, '09:00', '17:00']],
    });
    const res = await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.venue).toMatchObject({
      name: 'New Name',
      description: 'Old description',
      location: 'Old place',
    });
    expect(res.body.venue.hours[1].periods).toEqual([{ opensAt: '09:00', closesAt: '17:00' }]);
  });

  test('can change the text, the category and everything else in one go', async () => {
    const { admin, category } = await setup();
    const other = await createCategory('Dining Hall');
    const venue = await createVenue({ category });
    const res = await admin.agent
      .patch(`/api/admin/venues/${venue.id}`)
      .send({ name: 'N', description: 'D', location: 'L', categoryId: other.id });
    expect(res.body.venue).toMatchObject({
      name: 'N',
      description: 'D',
      location: 'L',
      category: { id: other.id, name: 'Dining Hall' },
    });
  });

  test('sending hours replaces ALL the old hours', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({
      category,
      hours: [
        [1, '09:00', '17:00'],
        [2, '09:00', '17:00'],
        [3, '09:00', '17:00'],
      ],
    });
    const res = await admin.agent
      .patch(`/api/admin/venues/${venue.id}`)
      .send({ hours: [{ dayOfWeek: 6, opensAt: '10:00', closesAt: '14:00' }] });
    expect(res.body.venue.hours.filter((d) => !d.isClosed).map((d) => d.dayOfWeek)).toEqual([6]);
    expect(await VenueHour.count({ where: { venue_id: venue.id } })).toBe(1);
  });

  test('sending specialHours replaces them; an empty list clears them', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({
      category,
      special: [{ date: '2099-01-01', is_closed: true, note: 'New Year' }],
    });
    await admin.agent
      .patch(`/api/admin/venues/${venue.id}`)
      .send({ specialHours: [{ date: '2099-02-02', isClosed: true }] });
    expect(
      (await VenueSpecialHour.findAll({ where: { venue_id: venue.id } })).map((r) => r.date)
    ).toEqual(['2099-02-02']);
    await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({ specialHours: [] });
    expect(await VenueSpecialHour.count({ where: { venue_id: venue.id } })).toBe(0);
  });

  test('leaving hours out keeps the old hours', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ category, hours: [[1, '09:00', '17:00']] });
    await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({ name: 'Renamed' });
    expect(await VenueHour.count({ where: { venue_id: venue.id } })).toBe(1);
  });

  test('a change that fails part-way changes nothing at all', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ name: 'Before', category, hours: [[1, '09:00', '17:00']] });
    const res = await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({
      name: 'After',
      categoryId: 999999, // does not exist
      hours: [{ dayOfWeek: 3, opensAt: '10:00', closesAt: '11:00' }],
    });
    expect(res.status).toBe(400);
    expect((await Venue.findByPk(venue.id)).name).toBe('Before');
    const hours = await VenueHour.findAll({ where: { venue_id: venue.id }, raw: true });
    expect(hours.map((h) => h.day_of_week)).toEqual([1]);
    expect((await auditRows()).filter((r) => r.event_type === 'venue_updated')).toHaveLength(0);
  });

  test('empty or invalid changes are refused', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ category });
    expect(field(await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({}), 'name')).toBe(
      'Send at least one thing to change'
    );
    expect(
      (await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({ name: '' })).status
    ).toBe(400);
    expect(
      (await admin.agent.patch(`/api/admin/venues/${venue.id}`).send({ hours: [] })).status
    ).toBe(400);
  });

  test('unknown and impossible ids are 404; status cannot be changed this way', async () => {
    const { admin, category } = await setup();
    for (const id of [424242, 'abc', 0, 2147483648])
      expect((await admin.agent.patch(`/api/admin/venues/${id}`).send({ name: 'x' })).status).toBe(
        404
      );
    const venue = await createVenue({ category });
    await admin.agent
      .patch(`/api/admin/venues/${venue.id}`)
      .send({ name: 'x', status: 'inactive' });
    expect((await Venue.findByPk(venue.id)).status).toBe('active');
  });

  test('works on a deactivated venue, and is audited with what changed', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ category, status: 'inactive' });
    expect(
      (
        await admin.agent
          .patch(`/api/admin/venues/${venue.id}`)
          .send({ name: 'Edited', location: 'Elsewhere' })
      ).status
    ).toBe(200);
    const [row] = (await auditRows()).filter((r) => r.event_type === 'venue_updated');
    expect(row).toMatchObject({
      actor_id: admin.user.id,
      entity_id: venue.id,
      details: { changed: ['name', 'location'] },
    });
  });
});

describe('deactivate and reactivate (FR#47)', () => {
  test('deactivating hides the venue everywhere public but keeps its reviews; reactivating brings it back', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ name: 'Seasonal Stand', category, menu: ['Lemonade'] });
    const { user } = await createUser();
    const review = await createReview({ user, venue, rating: 5, body: 'lovely' });

    const off = await admin.agent.post(`/api/admin/venues/${venue.id}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.venue.status).toBe('inactive');
    expect((await request(app).get('/api/venues')).body.total).toBe(0);
    expect((await request(app).get('/api/venues?q=lemonade')).body.total).toBe(0);
    expect((await request(app).get(`/api/venues/${venue.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/venues/${venue.id}/reviews`)).status).toBe(404);
    expect(await Review.findByPk(review.id)).not.toBeNull(); // the review is NOT deleted

    const on = await admin.agent.post(`/api/admin/venues/${venue.id}/reactivate`);
    expect(on.body.venue.status).toBe('active');
    const page = (await request(app).get(`/api/venues/${venue.id}`)).body.venue;
    expect(page).toMatchObject({ reviewCount: 1, avgRating: 5 });
    expect((await request(app).get(`/api/venues/${venue.id}/reviews`)).body.reviews[0].body).toBe(
      'lovely'
    );
  });

  test('new reviews cannot be posted while a venue is deactivated', async () => {
    const { category } = await setup();
    const venue = await createVenue({ category, status: 'inactive' });
    const student = await loginAs(app, { username: 'eager_student' });
    expect(
      (await student.agent.post(`/api/venues/${venue.id}/reviews`).send({ rating: 5 })).status
    ).toBe(404);
  });

  test('doing it twice is harmless, and only a real change is audited', async () => {
    const { admin, category } = await setup();
    const venue = await createVenue({ category });
    await admin.agent.post(`/api/admin/venues/${venue.id}/deactivate`);
    expect((await admin.agent.post(`/api/admin/venues/${venue.id}/deactivate`)).status).toBe(200);
    await admin.agent.post(`/api/admin/venues/${venue.id}/reactivate`);
    expect((await admin.agent.post(`/api/admin/venues/${venue.id}/reactivate`)).status).toBe(200);
    const events = (await auditRows())
      .map((r) => r.event_type)
      .filter((type) => type.startsWith('venue_'));
    expect(events).toEqual(['venue_deactivated', 'venue_reactivated']);
  });

  test('unknown and impossible ids are 404', async () => {
    const { admin } = await setup();
    for (const action of ['deactivate', 'reactivate']) {
      for (const id of [424242, 'abc', 0])
        expect((await admin.agent.post(`/api/admin/venues/${id}/${action}`)).status).toBe(404);
    }
  });
});

describe('protection', () => {
  test('cannot be driven from another website', async () => {
    const { admin, category } = await setup();
    const res = await admin.agent
      .post('/api/admin/venues')
      .set('Origin', 'https://evil.example')
      .send(validVenue(category));
    expect(res.status).toBe(403);
    expect(await Venue.count()).toBe(0);
  });
});
