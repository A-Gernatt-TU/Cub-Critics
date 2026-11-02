// Shared helpers for integration tests.
const bcrypt = require('bcrypt');
const { sequelize, User } = require('../../models');
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

module.exports = {
  resetDb,
  closeAll,
  createUser,
  getSetCookie,
  validRegistration,
  sequelize,
};
