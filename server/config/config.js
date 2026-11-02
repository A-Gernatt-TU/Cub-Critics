'use strict';
// Used by sequelize-cli (migrations, seeders) and by models/index.js.
// Set DATABASE_URL if your host gives you one (most do); otherwise use the DB_* values.
// Nothing here depends on a specific hosting provider (SQ#5, TBD-2).
const { resolveDatabase } = require('./database');

function forEnv(nodeEnv) {
  const db = resolveDatabase(nodeEnv);
  return {
    ...(db.url
      ? { use_env_variable: db.urlVar }
      : {
          username: db.user,
          password: db.password,
          database: db.database,
          host: db.host,
          port: db.port,
        }),
    dialect: 'postgres',
    logging: false,
    // Many hosted Postgres services require SSL; turn on with DB_SSL=true.
    dialectOptions: db.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  };
}

module.exports = {
  development: forEnv('development'),
  test: forEnv('test'),
  production: forEnv('production'),
};
