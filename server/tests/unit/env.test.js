const { loadConfig } = require('../../config/env');

const dbEnv = { DB_NAME: 'cub', DB_USER: 'me', SESSION_SECRET: 'dev-secret' };

describe('loadConfig', () => {
  test('applies development defaults', () => {
    const c = loadConfig({ ...dbEnv });
    expect(c).toMatchObject({
      nodeEnv: 'development',
      port: 3001,
      trustProxy: 0,
      logLevel: 'debug',
    });
    expect(c.allowedOrigins).toEqual([]);
  });

  test('production defaults to one trusted proxy and info logging', () => {
    const c = loadConfig({ ...dbEnv, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) });
    expect(c).toMatchObject({
      isProduction: true,
      trustProxy: 1,
      logLevel: 'info',
      cookieSecure: true,
    });
  });

  test('parses a comma separated origin list', () => {
    const c = loadConfig({
      ...dbEnv,
      ALLOWED_ORIGINS: 'http://localhost:5173, https://cubcritics.example',
    });
    expect(c.allowedOrigins).toEqual(['http://localhost:5173', 'https://cubcritics.example']);
  });

  test('accepts DATABASE_URL instead of DB_* values', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://u@h/db', SESSION_SECRET: 'dev-secret' })
    ).not.toThrow();
  });

  test('reports every problem at once', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'staging', SERVER_PORT: 'abc', ALLOWED_ORIGINS: 'http://x.com/path/' })
    ).toThrow(/NODE_ENV[\s\S]*SERVER_PORT[\s\S]*ALLOWED_ORIGINS[\s\S]*Database is not configured/);
  });

  test('production refuses a missing, default, or short SESSION_SECRET', () => {
    const base = { DB_NAME: 'cub', DB_USER: 'me', NODE_ENV: 'production' };
    expect(() => loadConfig(base)).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'change_me' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  test('test mode does not require a database or a session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({ bcryptRounds: 4 });
  });

  test('a session secret is required in every non-test mode', () => {
    expect(() => loadConfig({ DB_NAME: 'cub', DB_USER: 'me' })).toThrow(
      /SESSION_SECRET is required/
    );
  });

  test('cookie settings are validated', () => {
    expect(() => loadConfig({ ...dbEnv, COOKIE_SAMESITE: 'sideways' })).toThrow(/COOKIE_SAMESITE/);
    expect(() => loadConfig({ ...dbEnv, COOKIE_SECURE: 'maybe' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadConfig({ ...dbEnv, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' })).toThrow(
      /requires COOKIE_SECURE=true/
    );
    expect(loadConfig({ ...dbEnv, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' })).toMatchObject({
      cookieSameSite: 'none',
      cookieSecure: true,
    });
  });

  test('production never allows insecure cookies', () => {
    expect(() =>
      loadConfig({
        ...dbEnv,
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        COOKIE_SECURE: 'false',
      })
    ).toThrow(/COOKIE_SECURE must not be false in production/);
  });

  test('parses and validates ALLOWED_EMAIL_DOMAINS (TBD-1)', () => {
    expect(
      loadConfig({ ...dbEnv, ALLOWED_EMAIL_DOMAINS: 'Towson.edu, students.towson.edu' })
        .allowedEmailDomains
    ).toEqual(['towson.edu', 'students.towson.edu']);
    expect(() => loadConfig({ ...dbEnv, ALLOWED_EMAIL_DOMAINS: 'towson' })).toThrow(
      /ALLOWED_EMAIL_DOMAINS/
    );
  });

  test('validates BCRYPT_ROUNDS and defaults TOS_VERSION', () => {
    expect(() => loadConfig({ ...dbEnv, BCRYPT_ROUNDS: '3' })).toThrow(/BCRYPT_ROUNDS/);
    expect(() => loadConfig({ ...dbEnv, BCRYPT_ROUNDS: '16' })).toThrow(/BCRYPT_ROUNDS/);
    expect(loadConfig({ ...dbEnv, BCRYPT_ROUNDS: '10', TOS_VERSION: 'v2' })).toMatchObject({
      bcryptRounds: 10,
      tosVersion: 'v2',
    });
    expect(loadConfig(dbEnv).tosVersion).toBe('draft-1');
  });
});
