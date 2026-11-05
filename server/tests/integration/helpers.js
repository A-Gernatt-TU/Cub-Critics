// Shared helpers for integration tests.
const bcrypt = require('bcrypt');
const request = require('supertest');
const {
  sequelize,
  User,
  Category,
  Venue,
  VenueHour,
  VenueSpecialHour,
  VenuePhoto,
  MenuItem,
  Review,
  Achievement,
} = require('../../models');
const { closeSessionStore } = require('../../config/session');

// Safety net: tests wipe tables, so never run them on a non-test database.
function assertTestDatabase() {
  const name = sequelize.config.database;
  if (!name || !name.endsWith('_test')) {
    throw new Error(`Refusing to wipe database "${name}": its name does not end in "_test".`);
  }
}

async function resetDb() {
  assertTestDatabase();
  await sequelize.query(
    'TRUNCATE users, categories, achievements, audit_log, sessions RESTART IDENTITY CASCADE'
  );
}

async function closeAll() {
  await closeSessionStore();
  await sequelize.close();
}

let counter = 0;
// Inserts a user directly (fast), bypassing the API.
async function createUser(overrides = {}) {
  counter += 1;
  const password = overrides.password || 'Passw0rdTest';
  const user = await User.create({
    email: overrides.email || `user${counter}@example.com`,
    username: overrides.username || `user_${counter}`,
    password_hash: await bcrypt.hash(password, 4),
    role: overrides.role || 'student',
    status: overrides.status || 'active',
    tos_version: 'test-1',
    tos_accepted_at: new Date(),
  });
  return { user, password };
}

// Pulls one cookie's attributes out of a supertest response.
function getSetCookie(res, name = 'cubcritics.sid') {
  const cookies = res.headers['set-cookie'] || [];
  return cookies.find((c) => c.startsWith(`${name}=`));
}

const validRegistration = (overrides = {}) => ({
  email: 'new.student@example.com',
  username: 'new_student',
  password: 'Passw0rd1',
  acceptTerms: true,
  ...overrides,
});

// ---- venue fixtures --------------------------------------------------------------------
let fixtureCounter = 0;
const uniq = (prefix) => `${prefix} ${(fixtureCounter += 1)}`;

async function createCategory(name) {
  return Category.create({ name: name || uniq('Category') });
}

// hours: 'always' (open every day, all day), 'never' (no hours), or a list of
// [dayOfWeek, 'HH:MM', 'HH:MM'] rows.
const WEEKDAYS_7_TO_8 = [1, 2, 3, 4, 5].map((d) => [d, '07:00', '20:00']);

async function createVenue({
  name,
  category,
  status = 'active',
  description = 'A place to eat.',
  location = 'Student Union',
  hours = 'never',
  special = [],
  menu = [],
  photos = [],
} = {}) {
  const cat = category || (await createCategory());
  const venue = await Venue.create({
    name: name || uniq('Venue'),
    category_id: cat.id,
    status,
    description,
    location,
  });
  const rows =
    hours === 'always'
      ? [0, 1, 2, 3, 4, 5, 6].map((d) => [d, '00:00', '00:00'])
      : hours === 'never'
        ? []
        : hours;
  for (const [day_of_week, opens_at, closes_at] of rows) {
    await VenueHour.create({ venue_id: venue.id, day_of_week, opens_at, closes_at });
  }
  for (const entry of special) {
    await VenueSpecialHour.create({ venue_id: venue.id, ...entry });
  }
  for (const item of menu) {
    const [itemName, price = 5, itemDescription = null] = Array.isArray(item) ? item : [item];
    await MenuItem.create({
      venue_id: venue.id,
      name: itemName,
      price,
      description: itemDescription,
    });
  }
  for (const [index, key] of photos.entries()) {
    await VenuePhoto.create({ venue_id: venue.id, storage_key: key, sort_order: index });
  }
  return venue;
}

async function createReview({
  user,
  venue,
  rating = 5,
  body = null,
  status = 'published',
  createdAt,
  editedAt,
}) {
  return Review.create({
    user_id: user.id,
    venue_id: venue.id,
    rating,
    body,
    status,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(editedAt ? { edited_at: editedAt } : {}),
  });
}

// A supertest agent that is already logged in as a new (or given) account.
async function loginAs(app, overrides = {}) {
  const account = await createUser(overrides);
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email: account.user.email, password: account.password });
  if (res.status !== 200)
    throw new Error(`Test login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, ...account };
}

// The four badges from FR#16 (names are placeholders until TBD-4).
async function seedAchievements() {
  const defs = [
    ['First Bite', 1],
    ['Taste Tester', 5],
    ['Campus Critic', 10],
    ['Head Critic', 25],
  ];
  for (const [name, review_threshold] of defs) await Achievement.create({ name, review_threshold });
}

module.exports = {
  loginAs,
  seedAchievements,
  createCategory,
  createVenue,
  createReview,
  WEEKDAYS_7_TO_8,
  resetDb,
  closeAll,
  createUser,
  getSetCookie,
  validRegistration,
  sequelize,
};
