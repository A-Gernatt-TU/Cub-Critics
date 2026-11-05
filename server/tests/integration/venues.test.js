// Public venue endpoints (FR#17-FR#23, FR#32-FR#39). Guests may use all of them (FR#9).
const request = require('supertest');
const app = require('../../app');
const {
  resetDb,
  closeAll,
  createUser,
  createCategory,
  createVenue,
  createReview,
  sequelize,
} = require('./helpers');

beforeEach(resetDb);
afterAll(closeAll);

const get = (url) => request(app).get(url);
const names = (res) => res.body.venues.map((v) => v.name);

describe('GET /api/categories', () => {
  test('lists categories alphabetically for the filter menu, no login needed', async () => {
    await createCategory('Grab-and-Go');
    await createCategory('Café');
    await createCategory('Dining Hall');
    const res = await get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c) => c.name)).toEqual(['Café', 'Dining Hall', 'Grab-and-Go']);
    expect(Object.keys(res.body.categories[0]).sort()).toEqual(['id', 'name']);
  });

  test('is an empty list, not an error, when there are none', async () => {
    expect((await get('/api/categories')).body).toEqual({ categories: [] });
  });
});

describe('GET /api/venues: the directory (FR#18)', () => {
  test('guests see active venues with everything a card needs', async () => {
    const cafe = await createCategory('Café');
    const venue = await createVenue({
      name: 'Paws Café',
      category: cafe,
      description: 'Coffee and pastries',
      location: 'Library',
      hours: 'always',
      photos: ['venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'],
    });
    const { user } = await createUser();
    await createReview({ user, venue, rating: 4 });

    const res = await get('/api/venues');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.venues[0]).toEqual({
      id: venue.id,
      name: 'Paws Café',
      description: 'Coffee and pastries',
      location: 'Library',
      category: { id: cafe.id, name: 'Café' },
      thumbnailUrl: '/api/files/venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
      avgRating: 4,
      reviewCount: 1,
      openStatus: { isOpen: true, closesAt: expect.any(String), nextOpen: null },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('inactive venues are hidden (FR#47)', async () => {
    await createVenue({ name: 'Open One' });
    await createVenue({ name: 'Closed Down', status: 'inactive' });
    expect(names(await get('/api/venues'))).toEqual(['Open One']);
  });

  test('default order is A to Z, ignoring letter case', async () => {
    for (const name of ['zebra grill', 'Apple Bar', 'banana Stand', 'Cherry Hall'])
      await createVenue({ name });
    expect(names(await get('/api/venues'))).toEqual([
      'Apple Bar',
      'banana Stand',
      'Cherry Hall',
      'zebra grill',
    ]);
  });

  test('a venue with no photo has thumbnailUrl null (the frontend shows its placeholder, FR#22)', async () => {
    await createVenue({ name: 'No Photo' });
    expect((await get('/api/venues')).body.venues[0].thumbnailUrl).toBeNull();
  });

  test('the thumbnail is the first photo in display order', async () => {
    await createVenue({
      name: 'Two Photos',
      photos: [
        'venue-photos/11111111-1111-4111-8111-111111111111.png',
        'venue-photos/22222222-2222-4222-8222-222222222222.png',
      ],
    });
    expect((await get('/api/venues')).body.venues[0].thumbnailUrl).toBe(
      '/api/files/venue-photos/11111111-1111-4111-8111-111111111111.png'
    );
  });

  test('no venues is an empty list with total 0 (the frontend shows "no matching venues", FR#39)', async () => {
    expect((await get('/api/venues')).body).toEqual({ venues: [], total: 0 });
  });
});

describe('Ratings in the directory (FR#23)', () => {
  test('average to ONE decimal place, counting only publicly visible reviews', async () => {
    const venue = await createVenue({ name: 'Rated' });
    const people = [];
    for (let i = 0; i < 6; i += 1)
      people.push((await createUser({ email: `p${i}@example.com`, username: `person_${i}` })).user);
    await createReview({ user: people[0], venue, rating: 5, status: 'published' });
    await createReview({ user: people[1], venue, rating: 4, status: 'reported' }); // still public
    await createReview({ user: people[2], venue, rating: 4, status: 'published' });
    await createReview({ user: people[3], venue, rating: 1, status: 'flagged' }); // hidden: not counted
    await createReview({ user: people[4], venue, rating: 1, status: 'removed' }); // hidden: not counted
    const [v] = (await get('/api/venues')).body.venues;
    expect(v.reviewCount).toBe(3);
    expect(v.avgRating).toBe(4.3); // (5+4+4)/3 = 4.333...
  });

  test('rounds .x5 up, like a person would', async () => {
    const venue = await createVenue({ name: 'Rounding' });
    const a = (await createUser({ email: 'a@example.com', username: 'aaa' })).user;
    const b = (await createUser({ email: 'b@example.com', username: 'bbb' })).user;
    await createReview({ user: a, venue, rating: 4 });
    await createReview({ user: b, venue, rating: 5 }); // 4.5
    expect((await get('/api/venues')).body.venues[0].avgRating).toBe(4.5);
    const c = (await createUser({ email: 'c@example.com', username: 'ccc' })).user;
    const d = (await createUser({ email: 'd@example.com', username: 'ddd' })).user;
    await createReview({ user: c, venue, rating: 4 });
    await createReview({ user: d, venue, rating: 4 }); // 17/4 = 4.25 -> 4.3
    expect((await get('/api/venues')).body.venues[0].avgRating).toBe(4.3);
  });

  test('a venue nobody has reviewed shows null and 0, never NaN', async () => {
    await createVenue({ name: 'Unrated' });
    expect((await get('/api/venues')).body.venues[0]).toMatchObject({
      avgRating: null,
      reviewCount: 0,
    });
  });

  test('the average follows the reviews: adding, editing and hiding all update it (SQ#3)', async () => {
    const venue = await createVenue({ name: 'Live' });
    const { user } = await createUser();
    const review = await createReview({ user, venue, rating: 2 });
    const rating = async () => (await get('/api/venues')).body.venues[0].avgRating;
    expect(await rating()).toBe(2);
    await review.update({ rating: 5 });
    expect(await rating()).toBe(5);
    await review.update({ status: 'flagged' });
    expect(await rating()).toBeNull();
    await review.update({ status: 'published' });
    expect(await rating()).toBe(5);
    await review.destroy();
    expect(await rating()).toBeNull();
  });
});

describe('Sorting (FR#38)', () => {
  test('sort=rating: highest first, unrated last, ties go to more reviews then name', async () => {
    const mk = async (name, ratings) => {
      const venue = await createVenue({ name });
      for (const [i, rating] of ratings.entries()) {
        const { user } = await createUser({
          email: `${name}${i}@example.com`.replace(/\s/g, ''),
          username: `${name}${i}`.replace(/\s/g, ''),
        });
        await createReview({ user, venue, rating });
      }
    };
    await mk('Bravo', [5]);
    await mk('Alpha', [5]);
    await mk('Charlie', [5, 5, 5]); // same 5.0, but more reviews: first
    await mk('Delta', [3, 4]); // 3.5
    await mk('Echo', []); // unrated: last
    expect(names(await get('/api/venues?sort=rating'))).toEqual([
      'Charlie',
      'Alpha',
      'Bravo',
      'Delta',
      'Echo',
    ]);
  });

  test('sort=name is the same as the default', async () => {
    for (const name of ['B', 'A']) await createVenue({ name });
    expect(names(await get('/api/venues?sort=name'))).toEqual(['A', 'B']);
  });

  test('an unknown sort is a clear 400', async () => {
    const res = await get('/api/venues?sort=cheapest');
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'sort', message: 'Sort must be one of: name, rating' },
    ]);
  });

  test('limit gives the top N for the home page (FR#17) but total still counts everything', async () => {
    for (const name of ['A', 'B', 'C', 'D']) await createVenue({ name });
    const res = await get('/api/venues?sort=rating&limit=2');
    expect(res.body.venues).toHaveLength(2);
    expect(res.body.total).toBe(4);
  });
});

describe('Search (FR#32, FR#33)', () => {
  beforeEach(async () => {
    await createVenue({
      name: 'Pizza Palace',
      menu: [
        ['Cheese Slice', 3],
        ['Garlic Knots', 4],
      ],
    });
    await createVenue({
      name: 'Campus Café',
      menu: [
        ['Chicken Wrap', 7],
        ['Latte', 4],
      ],
    });
    await createVenue({
      name: 'Wrap Shack',
      menu: [
        ['Veggie Wrap', 6],
        ['Chicken Wrap', 7],
        ['Falafel Wrap', 7],
        ['Hummus Wrap', 6],
      ],
    });
  });

  test('matches the venue name, ignoring case and surrounding spaces', async () => {
    expect(names(await get('/api/venues?q=PIZZA'))).toEqual(['Pizza Palace']);
    expect(names(await get('/api/venues?q=%20%20campus%20%20'))).toEqual(['Campus Café']);
    expect(names(await get('/api/venues?q=palace'))).toEqual(['Pizza Palace']);
  });

  test('matches menu items and returns the venues that serve them, saying which items matched', async () => {
    const res = await get('/api/venues?q=chicken');
    expect(names(res)).toEqual(['Campus Café', 'Wrap Shack']);
    expect(res.body.venues[0].matchedMenuItems).toEqual(['Chicken Wrap']);
  });

  test('a name match and an item match both count; each venue appears once', async () => {
    const res = await get('/api/venues?q=wrap');
    expect(names(res)).toEqual(['Campus Café', 'Wrap Shack']);
    expect(res.body.total).toBe(2);
    expect(res.body.venues[1].matchedMenuItems).toHaveLength(3); // capped at 3 of its 4 matching items
  });

  test('without a search term there is no matchedMenuItems field', async () => {
    expect((await get('/api/venues')).body.venues[0]).not.toHaveProperty('matchedMenuItems');
  });

  test('an empty or blank search returns everything', async () => {
    expect((await get('/api/venues?q=')).body.total).toBe(3);
    expect((await get('/api/venues?q=%20%20')).body.total).toBe(3);
  });

  test('no matches is an empty list', async () => {
    expect((await get('/api/venues?q=sushi')).body).toEqual({ venues: [], total: 0 });
  });

  test('% and _ are ordinary characters, not wildcards', async () => {
    expect((await get('/api/venues?q=%25')).body.total).toBe(0);
    expect((await get('/api/venues?q=_')).body.total).toBe(0);
    expect((await get('/api/venues?q=p_zza')).body.total).toBe(0);
    expect((await get('/api/venues?q=%5C')).body.total).toBe(0);
  });

  test('literal % in a real name can be found', async () => {
    await createVenue({ name: '100% Juice' });
    expect(names(await get('/api/venues?q=100%25'))).toEqual(['100% Juice']);
  });

  test('quotes and SQL-looking text are harmless', async () => {
    for (const q of [
      "'",
      `"; DROP TABLE venues;--`,
      "' OR '1'='1",
      "Robert'); DROP TABLE users;--",
    ]) {
      const res = await get(`/api/venues?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    }
    expect((await get('/api/venues')).body.total).toBe(3); // tables intact
    await sequelize.query('SELECT 1 FROM users');
  });

  test('accented and non-English text works', async () => {
    await createVenue({ name: 'Crêperie Française' });
    expect(names(await get(`/api/venues?q=${encodeURIComponent('crêperie')}`))).toEqual([
      'Crêperie Française',
    ]);
  });

  test('a search over 100 characters is a clear 400', async () => {
    const res = await get(`/api/venues?q=${'a'.repeat(101)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toEqual({
      field: 'q',
      message: 'Search must be 100 characters or fewer',
    });
  });

  test('a repeated q parameter is refused, not guessed at', async () => {
    expect((await get('/api/venues?q=a&q=b')).status).toBe(400);
  });
});

describe('Filters (FR#34, FR#35, FR#36, FR#37)', () => {
  test('by category: one, several (comma or repeated), or none', async () => {
    const cafe = await createCategory('Café');
    const hall = await createCategory('Dining Hall');
    const go = await createCategory('Grab-and-Go');
    await createVenue({ name: 'A Café', category: cafe });
    await createVenue({ name: 'B Hall', category: hall });
    await createVenue({ name: 'C Go', category: go });
    expect(names(await get(`/api/venues?category=${cafe.id}`))).toEqual(['A Café']);
    expect(names(await get(`/api/venues?category=${cafe.id},${go.id}`))).toEqual([
      'A Café',
      'C Go',
    ]);
    expect(names(await get(`/api/venues?category=${hall.id}&category=${go.id}`))).toEqual([
      'B Hall',
      'C Go',
    ]);
    expect((await get('/api/venues?category=999999')).body.total).toBe(0);
  });

  test('a bad category list is a 400 on the "category" field', async () => {
    for (const value of ['abc', '1,x', '0', '-1', '1.5', '99999999999']) {
      const res = await get(`/api/venues?category=${value}`);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('category');
    }
  });

  test('by minimum rating: includes equal, excludes lower, and excludes unrated', async () => {
    const mk = async (name, rating, i) => {
      const venue = await createVenue({ name });
      if (rating) {
        const { user } = await createUser({ email: `u${i}@example.com`, username: `user_${i}` });
        await createReview({ user, venue, rating });
      }
    };
    await mk('Five', 5, 1);
    await mk('Four', 4, 2);
    await mk('Three', 3, 3);
    await mk('Unrated', null, 4);
    expect(names(await get('/api/venues?minRating=4'))).toEqual(['Five', 'Four']);
    expect(names(await get('/api/venues?minRating=4.5'))).toEqual(['Five']);
    expect(names(await get('/api/venues?minRating=0'))).toEqual([
      'Five',
      'Four',
      'Three',
      'Unrated',
    ]);
    expect((await get('/api/venues?minRating=5')).body.total).toBe(1);
  });

  test('minimum rating outside 0-5 or not a number is a 400', async () => {
    for (const value of ['6', '-1', 'high', '4.']) {
      const res = await get(`/api/venues?minRating=${value}`);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('minRating');
    }
  });

  test('open now keeps only venues that are open at this moment', async () => {
    await createVenue({ name: 'Always Open', hours: 'always' });
    await createVenue({ name: 'No Hours Listed' });
    expect(names(await get('/api/venues?openNow=true'))).toEqual(['Always Open']);
    expect(names(await get('/api/venues?openNow=1'))).toEqual(['Always Open']);
    expect(names(await get('/api/venues?openNow=false'))).toEqual([
      'Always Open',
      'No Hours Listed',
    ]);
    expect((await get('/api/venues?openNow=maybe')).status).toBe(400);
  });

  test('all filters and the search apply together, and total counts the matches (FR#37)', async () => {
    const cafe = await createCategory('Café');
    const hall = await createCategory('Dining Hall');
    const mk = async (name, category, hours, rating, menu, i) => {
      const venue = await createVenue({ name, category, hours, menu });
      const { user } = await createUser({ email: `u${i}@example.com`, username: `user_${i}` });
      await createReview({ user, venue, rating });
    };
    await mk('Match', cafe, 'always', 5, ['Chicken Wrap'], 1);
    await mk('Wrong Category', hall, 'always', 5, ['Chicken Wrap'], 2);
    await mk('Closed', cafe, 'never', 5, ['Chicken Wrap'], 3);
    await mk('Low Rated', cafe, 'always', 2, ['Chicken Wrap'], 4);
    await mk('Salad Only', cafe, 'always', 5, ['Salad'], 5);
    const res = await get(
      `/api/venues?q=chicken&category=${cafe.id}&minRating=4&openNow=true&sort=rating`
    );
    expect(names(res)).toEqual(['Match']);
    expect(res.body.total).toBe(1);
  });

  test('unknown query parameters are ignored', async () => {
    await createVenue({ name: 'A' });
    expect((await get('/api/venues?color=red&__proto__=x')).body.total).toBe(1);
  });
});

describe('GET /api/venues/:id: a venue page (FR#19, FR#20, FR#22)', () => {
  test('shows description, location, category, hours, menu, rating and open status', async () => {
    const cafe = await createCategory('Café');
    const venue = await createVenue({
      name: 'Paws Café',
      category: cafe,
      description: 'Coffee',
      location: 'Library',
      hours: [
        [1, '07:00', '20:00'],
        [2, '07:00', '20:00'],
      ],
      menu: [
        ['Muffin', 2.75, 'Baked daily'],
        ['Latte', 4.25],
      ],
      photos: ['venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'],
    });
    const { user } = await createUser();
    await createReview({ user, venue, rating: 3 });

    const res = await get(`/api/venues/${venue.id}`);
    expect(res.status).toBe(200);
    const v = res.body.venue;
    expect(v).toMatchObject({
      id: venue.id,
      name: 'Paws Café',
      description: 'Coffee',
      location: 'Library',
      category: { id: cafe.id, name: 'Café' },
      avgRating: 3,
      reviewCount: 1,
    });
    expect(v).not.toHaveProperty('status'); // internal detail, only shown to administrators
    // Whether it is open depends on the clock when the test runs, so check the shape and that
    // the pieces agree with each other.
    expect(Object.keys(v.openStatus).sort()).toEqual(['closesAt', 'isOpen', 'nextOpen']);
    if (v.openStatus.isOpen) {
      expect(v.openStatus.closesAt).toMatch(/^\d{2}:\d{2}$/);
      expect(v.openStatus.nextOpen).toBeNull();
    } else {
      expect(v.openStatus.closesAt).toBeNull();
      expect(v.openStatus.nextOpen).toEqual({
        dayOfWeek: expect.any(Number),
        time: '07:00',
        isToday: expect.any(Boolean),
      });
    }
    expect(v.hours).toHaveLength(7);
    expect(v.hours[1]).toEqual({
      dayOfWeek: 1,
      isClosed: false,
      periods: [{ opensAt: '07:00', closesAt: '20:00' }],
    });
    expect(v.hours[0]).toEqual({ dayOfWeek: 0, isClosed: true, periods: [] });
    expect(v.photos).toEqual([
      {
        id: expect.any(Number),
        url: '/api/files/venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
      },
    ]);
  });

  test('the menu: sorted by name, prices are numbers, and carries the allergy notice (FR#20, SF#3)', async () => {
    const venue = await createVenue({
      menu: [
        ['Zucchini Fries', 5.5],
        ['Apple Pie', 3, 'Warm'],
        ['Burger', 9.99],
      ],
    });
    const { menu } = (await get(`/api/venues/${venue.id}`)).body.venue;
    expect(menu.items.map((i) => i.name)).toEqual(['Apple Pie', 'Burger', 'Zucchini Fries']);
    expect(menu.items[0]).toEqual({
      id: expect.any(Number),
      name: 'Apple Pie',
      description: 'Warm',
      price: 3,
    });
    expect(menu.items[1].price).toBe(9.99);
    expect(typeof menu.items[2].price).toBe('number');
    expect(menu.notice).toMatch(/allerg/i);
    expect(menu.notice).toMatch(/confirm ingredients with venue staff/i);
  });

  test('the allergy notice is there even when the menu is empty', async () => {
    const venue = await createVenue();
    const { menu } = (await get(`/api/venues/${venue.id}`)).body.venue;
    expect(menu.items).toEqual([]);
    expect(menu.notice).toBeTruthy();
  });

  test('a venue with no photo has an empty photos list (the frontend shows its placeholder)', async () => {
    const venue = await createVenue();
    expect((await get(`/api/venues/${venue.id}`)).body.venue.photos).toEqual([]);
  });

  test('photos come back in display order', async () => {
    const venue = await createVenue({
      photos: [
        'venue-photos/11111111-1111-4111-8111-111111111111.png',
        'venue-photos/22222222-2222-4222-8222-222222222222.png',
      ],
    });
    const { photos } = (await get(`/api/venues/${venue.id}`)).body.venue;
    expect(photos.map((p) => p.url)).toEqual([
      '/api/files/venue-photos/11111111-1111-4111-8111-111111111111.png',
      '/api/files/venue-photos/22222222-2222-4222-8222-222222222222.png',
    ]);
  });

  test('upcoming holiday hours are listed; past ones are not', async () => {
    const next = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const venue = await createVenue({
      special: [
        { date: next, is_closed: true, note: 'Holiday' },
        { date: '2020-01-01', is_closed: true, note: 'Ancient history' },
      ],
    });
    const { specialHours } = (await get(`/api/venues/${venue.id}`)).body.venue;
    expect(specialHours).toEqual([{ date: next, note: 'Holiday', isClosed: true, periods: [] }]);
  });

  test('the open status of a venue open around the clock', async () => {
    const venue = await createVenue({ hours: 'always' });
    expect((await get(`/api/venues/${venue.id}`)).body.venue.openStatus.isOpen).toBe(true);
  });

  test('inactive venues give 404 to everyone', async () => {
    const venue = await createVenue({ status: 'inactive' });
    expect((await get(`/api/venues/${venue.id}`)).status).toBe(404);
  });

  test('a venue that does not exist gives a clean JSON 404', async () => {
    const res = await get('/api/venues/123456');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test.each(['abc', '0', '-1', '1.5', '007', '1e3', '99999999999', '2147483648', '%20', 'null'])(
    'the impossible id %p is a 404, never a server error',
    async (id) => {
      const res = await get(`/api/venues/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  );

  test('the biggest possible id is handled', async () => {
    expect((await get('/api/venues/2147483647')).status).toBe(404);
  });
});

describe('GET /api/venues/:id/reviews (FR#30)', () => {
  async function setup() {
    const venue = await createVenue({ name: 'Reviewed' });
    const users = [];
    for (let i = 0; i < 6; i += 1) {
      users.push(
        (await createUser({ email: `r${i}@example.com`, username: `reviewer_${i}` })).user
      );
    }
    return { venue, users };
  }
  const day = (n) => new Date(Date.UTC(2026, 9, n, 12));

  test('shows published and reported reviews, newest first, with the author as a username only', async () => {
    const { venue, users } = await setup();
    await createReview({ user: users[0], venue, rating: 5, body: 'Great', createdAt: day(1) });
    await createReview({
      user: users[1],
      venue,
      rating: 3,
      body: 'Fine',
      createdAt: day(3),
      status: 'reported',
    });
    await createReview({ user: users[2], venue, rating: 1, body: 'Bad', createdAt: day(2) });

    const res = await get(`/api/venues/${venue.id}/reviews`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.reviews.map((r) => r.body)).toEqual(['Fine', 'Bad', 'Great']);
    expect(res.body.reviews[0]).toEqual({
      id: expect.any(Number),
      rating: 3,
      body: 'Fine',
      createdAt: expect.any(String),
      edited: false,
      editedAt: null,
      author: { id: users[1].id, username: 'reviewer_1', profilePictureUrl: null },
      mine: false,
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/example\.com|password|status/i); // SF#4: no email, no moderation status
  });

  test('hides flagged and removed reviews (FR#43)', async () => {
    const { venue, users } = await setup();
    await createReview({ user: users[0], venue, body: 'visible' });
    await createReview({ user: users[1], venue, body: 'flagged one', status: 'flagged' });
    await createReview({ user: users[2], venue, body: 'removed one', status: 'removed' });
    const res = await get(`/api/venues/${venue.id}/reviews`);
    expect(res.body.reviews.map((r) => r.body)).toEqual(['visible']);
    expect(res.body.total).toBe(1);
  });

  test('an edited review is labeled, with the date of the change (FR#28)', async () => {
    const { venue, users } = await setup();
    await createReview({ user: users[0], venue, editedAt: day(5) });
    const [review] = (await get(`/api/venues/${venue.id}/reviews`)).body.reviews;
    expect(review.edited).toBe(true);
    expect(review.editedAt).toBe(day(5).toISOString());
  });

  test('sorting: oldest, highest, lowest', async () => {
    const { venue, users } = await setup();
    await createReview({ user: users[0], venue, rating: 3, body: 'mid', createdAt: day(1) });
    await createReview({ user: users[1], venue, rating: 5, body: 'top', createdAt: day(2) });
    await createReview({ user: users[2], venue, rating: 1, body: 'bottom', createdAt: day(3) });
    const bodies = async (sort) =>
      (await get(`/api/venues/${venue.id}/reviews?sort=${sort}`)).body.reviews.map((r) => r.body);
    expect(await bodies('newest')).toEqual(['bottom', 'top', 'mid']);
    expect(await bodies('oldest')).toEqual(['mid', 'top', 'bottom']);
    expect(await bodies('highest')).toEqual(['top', 'mid', 'bottom']);
    expect(await bodies('lowest')).toEqual(['bottom', 'mid', 'top']);
  });

  test('paging: limit and offset, with the total', async () => {
    const { venue, users } = await setup();
    for (const [i, user] of users.entries())
      await createReview({ user, venue, body: `r${i}`, createdAt: day(i + 1) });
    const page1 = (await get(`/api/venues/${venue.id}/reviews?limit=4`)).body;
    expect(page1.reviews.map((r) => r.body)).toEqual(['r5', 'r4', 'r3', 'r2']);
    expect(page1.total).toBe(6);
    const page2 = (await get(`/api/venues/${venue.id}/reviews?limit=4&offset=4`)).body;
    expect(page2.reviews.map((r) => r.body)).toEqual(['r1', 'r0']);
    expect((await get(`/api/venues/${venue.id}/reviews?offset=100`)).body).toEqual({
      reviews: [],
      total: 6,
    });
  });

  test('bad paging values are a 400 with the field named', async () => {
    const { venue } = await setup();
    for (const [qs, field] of [
      ['limit=0', 'limit'],
      ['limit=51', 'limit'],
      ['limit=x', 'limit'],
      ['offset=-1', 'offset'],
      ['sort=best', 'sort'],
    ]) {
      const res = await get(`/api/venues/${venue.id}/reviews?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe(field);
    }
  });

  test('the logged-in student sees their own review marked mine: true', async () => {
    const { venue } = await setup();
    const me = await createUser({ email: 'me@example.com', username: 'me_myself' });
    const other = await createUser({ email: 'other@example.com', username: 'someone_else' });
    await createReview({ user: me.user, venue, body: 'mine' });
    await createReview({ user: other.user, venue, body: 'theirs' });

    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: me.user.email, password: me.password });
    const reviews = (await agent.get(`/api/venues/${venue.id}/reviews`)).body.reviews;
    expect(reviews.find((r) => r.body === 'mine').mine).toBe(true);
    expect(reviews.find((r) => r.body === 'theirs').mine).toBe(false);
    // guests: never mine
    expect(
      (await get(`/api/venues/${venue.id}/reviews`)).body.reviews.every((r) => r.mine === false)
    ).toBe(true);
  });

  test('an expired or invalid session simply behaves like a guest here', async () => {
    const { venue, users } = await setup();
    await createReview({ user: users[0], venue });
    const res = await get(`/api/venues/${venue.id}/reviews`).set(
      'Cookie',
      'cubcritics.sid=s%3Aforged.sig'
    );
    expect(res.status).toBe(200);
  });

  test('unknown, inactive and impossible venue ids are 404', async () => {
    const inactive = await createVenue({ status: 'inactive' });
    for (const id of [inactive.id, 424242, 'abc', 0]) {
      expect((await get(`/api/venues/${id}/reviews`)).status).toBe(404);
    }
  });

  test('a venue with no reviews is an empty list', async () => {
    const venue = await createVenue();
    expect((await get(`/api/venues/${venue.id}/reviews`)).body).toEqual({ reviews: [], total: 0 });
  });
});
