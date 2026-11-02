// Runs before every integration test file: fixed, predictable settings that do not
// depend on your personal .env (dotenv never overrides values that are already set).
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'integration-test-session-secret-0123456789';
process.env.BCRYPT_ROUNDS = '4';
process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_SAMESITE = 'lax';
process.env.TOS_VERSION = 'test-1';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
// Test files that need other values set them again at the top of the file.
process.env.ALLOWED_EMAIL_DOMAINS = '';
process.env.TRUST_PROXY = '0';
// Security features have their own test files that switch them on; everywhere else they
// are off so unrelated tests are not affected by limits or redirects.
process.env.RATE_LIMITS_ENABLED = 'false';
process.env.FORCE_HTTPS = 'false';
process.env.RATE_LIMIT_GLOBAL_PER_MINUTE = '600';
