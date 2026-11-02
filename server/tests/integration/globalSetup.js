// Runs once before the integration tests: makes sure the TEST database exists and is
// migrated. It refuses to run against anything that is not clearly a test database.
const { execSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const { pgPoolOptions } = require('../../config/database');

module.exports = async () => {
  const options = pgPoolOptions('test');
  const name = options.database || new URL(options.connectionString).pathname.slice(1);

  if (!name || !name.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests: the test database name must end in "_test" (got "${name}").\n` +
        'Set DB_NAME in .env (the test database becomes "<DB_NAME>_test"), or set DB_NAME_TEST / TEST_DATABASE_URL.'
    );
  }

  const client = new Client(options);
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Cannot connect to the test database "${name}" (${err.message}).\n` +
        `Create it once, then run the tests again:   createdb ${name}\n` +
        `(or in psql: CREATE DATABASE ${name};)`,
      { cause: err }
    );
  } finally {
    await client.end().catch(() => {});
  }

  // Apply any migrations the test database is missing.
  try {
    execSync('npx sequelize-cli db:migrate --env test', {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(`Could not migrate the test database:\n${err.stdout}\n${err.stderr}`, {
      cause: err,
    });
  }
};
