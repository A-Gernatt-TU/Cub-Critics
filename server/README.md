# Cub Critics server

Node 22 + Express 5 + PostgreSQL 15+ (Sequelize models and migrations).

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in your values (**set `SESSION_SECRET`**)
3. Create the database named in `DB_NAME`, and an empty test database `<DB_NAME>_test`
   (for example `createdb cub_critics` and `createdb cub_critics_test`)
4. `npm run db:migrate`, then `npm run db:seed` (creates categories, badges, the first
   administrator from `ADMIN_*`, and demo venues in development)
5. `npm run dev` (auto-restarts on changes) or `npm start`

Check it is running: `curl localhost:3001/api/health`

## Scripts

| Command                                  | What it does                                  |
| ---------------------------------------- | --------------------------------------------- |
| `npm run dev` / `npm start`              | Run the server                                |
| `npm test`                               | All tests (unit + integration)                |
| `npm run test:unit`                      | Fast tests, no database needed                |
| `npm run test:integration`               | Tests against a real PostgreSQL test database |
| `npm run lint` / `npm run format`        | Check / auto-format the code                  |
| `npm run db:migrate` / `db:migrate:undo` | Apply / undo the latest migration             |
| `npm run db:seed` / `db:seed:undo:all`   | Add / remove seed data                        |

## Testing

Integration tests use their own database, `<DB_NAME>_test`, which they migrate and wipe
automatically. They refuse to run against any database whose name does not end in `_test`,
so your development data is never touched.

## Layout

routes -> controllers -> services -> models. The first line of every file says what it is
for and which SRS requirements it covers.

## Conventions

- **Controllers** are plain functions wrapped by `createHandler(extractInput, controller)`
  (`utils/handler.js`). They return `{ statusCode?, data? }`; they never touch `res`.
- **Validation**: `validate({ body: schema })` (`middleware/validate.js`) checks the request
  with zod and puts the cleaned values on `req.validated`. Read input from there.
- **Protecting routes**: `requireAuth` (any logged-in person) or `requireRole(ROLE.ADMINISTRATOR)`.
  Both set `req.user`, re-read from the database on every request.
- **JSON uses camelCase** (`profilePictureKey`); database columns are snake_case.
  `utils/serializers.js` converts, and lists fields explicitly so nothing leaks by accident.
- **Success responses** send `data` as the JSON body, as-is.
- **Errors** are thrown as the classes in `utils/httpExceptions.js` and always come back as
  `{ "error": { "code", "message", "details"?, "requestId" } }`. Validation errors put one
  `{ field, message }` per field in `details`. Unexpected errors return a generic message;
  the real error is only in the server log (look it up by `requestId`).
- **Every response** has an `X-Request-Id` header that matches the `requestId` in error bodies
  and in the log line for that request.
- **Logs** are JSON, one line per request. Passwords, cookies and query strings are never logged.

## API: authentication

Sessions use an HttpOnly cookie named `cubcritics.sid`. From the React app, every request
must send cookies: `fetch(url, { credentials: 'include' })`. All auth responses are
`Cache-Control: no-store`.

The user object returned everywhere:

```json
{
  "id": 7,
  "username": "will_b",
  "email": "will@example.com",
  "role": "student",
  "bio": null,
  "profilePictureKey": null,
  "createdAt": "2026-11-01T16:44:51.523Z"
}
```

| Endpoint                  | Body                                               | Success                                           |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `POST /api/auth/register` | `{ email, username, password, acceptTerms: true }` | `201 { user }`, already logged in                 |
| `POST /api/auth/login`    | `{ email, password }`                              | `200 { user }`                                    |
| `POST /api/auth/logout`   | none                                               | `204` (also when not logged in)                   |
| `GET  /api/auth/me`       | none                                               | `200 { user }` or `200 { user: null }` for guests |

Errors the frontend should handle:

| Status | `error.code`          | When                                                                   |
| ------ | --------------------- | ---------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`    | `details: [{ field, message }]`, one per field; show beside each field |
| 401    | `INVALID_CREDENTIALS` | wrong email or password (the same message for both, on purpose)        |
| 401    | `UNAUTHORIZED`        | a protected endpoint was called without a valid session                |
| 403    | `FORBIDDEN`           | logged in, but the role is not allowed ("Access denied")               |
| 429    | `ACCOUNT_LOCKED`      | 5 failed logins; `Retry-After` header = seconds left (15 minutes)      |
| 503    | `SERVICE_UNAVAILABLE` | database down. On `/me`, do **not** treat this as "logged out"         |

Rules enforced by the server: passwords are 8-72 characters with a letter and a number;
usernames are 3-30 letters, numbers or underscores; emails and usernames are unique ignoring
case; new accounts are always students (administrators are created in the database, never
through the API). Sessions end after 30 idle minutes (students) or 15 (administrators);
every request counts as activity.

## Security

What the server enforces on every request (SRS section 5.3):

| Protection                        | Details                                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS (SC#1)                      | Plain-HTTP page requests are redirected (308); plain-HTTP requests that carry data are refused unprocessed. `/api/health` is exempt. HSTS is sent.                                                          |
| Rate limits (SC#6)                | Per IP: 600 requests/minute overall, 20 _failed_ logins per 15 min, 20 registrations per hour. Reviews and reports will also be limited per account (30 and 20 per hour). Returns `429` + `Retry-After`.    |
| Forged cross-site requests (SC#5) | POST/PUT/PATCH/DELETE from an origin that is not in `ALLOWED_ORIGINS` (or the server's own) is refused with `403 ORIGIN_NOT_ALLOWED`, on top of the SameSite cookie.                                        |
| Bad input (SC#4)                  | NUL bytes and absurdly deep JSON are refused; every body is validated by zod; SQL only ever uses bound parameters (a test fails the build if SQL is built from strings).                                    |
| Uploads (SC#7)                    | Only real JPEG/PNG files (checked by content, not file name), size-capped, stored under a random name with no execute permission, served only through `/api/files/...` with `nosniff` and a sandbox policy. |
| Headers                           | `default-src 'none'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on every API response (an endpoint may override).                                                        |
| Logins                            | Per-account lockout (5 failures = 15 min), bcrypt hashes, identical answers for unknown email and wrong password, session replaced on login, role and status re-checked on every request.                   |

### Building endpoints with these tools

```js
const requireRole = require('../middleware/requireRole');
const { reviewWriteLimiters } = require('../middleware/rateLimiters');
const { uploadImage } = require('../middleware/upload');
const { safeText } = require('../validators/common');

// Text people write: bio: safeText('Bio', { max: 250 }), review: safeText('Review', { max: 1000, multiline: true })
router.post(
  '/venues/:id/reviews',
  requireAuth,
  ...reviewWriteLimiters,
  validate({ body: schema }),
  handler
);

// Images: req.image = { buffer, extension, size, originalFilename }, then
// storageService.saveImage({ folder: FOLDERS.PROFILE_PICTURES, buffer, extension }) -> key to store in the database
router.put(
  '/me/picture',
  requireAuth,
  ...uploadImage({ maxBytes: LIMITS.PROFILE_PICTURE_MAX_BYTES }),
  handler
);
// In responses, turn a stored key into a URL with storageService.urlFor(key) (the user serializer does this).
```

### Things to know

- **Rate-limit counts live in server memory.** Right for one server (typical low-cost hosting). If the app is ever run as several copies, switch to a shared store, or each copy counts separately.
- **Campus Wi-Fi puts many students behind one IP address**, so the per-IP limits are generous on purpose, and successful logins are not counted.
- **Behind a host that provides HTTPS you must set `TRUST_PROXY=1`** (the production default). Production refuses to start with settings that would silently break login.
- **Not done (not in the SRS):** photo metadata such as GPS location is not stripped from uploads; sessions have no absolute maximum age (only idle timeouts); there are no CSRF tokens (the SameSite cookie plus the origin check cover the supported setup, but add tokens before using `COOKIE_SAMESITE=none`).

## Notes for deployment

- Behind a host that provides HTTPS, set `TRUST_PROXY=1` (the production default). Otherwise the
  server thinks requests are plain HTTP and **will not send the Secure session cookie**,
  so nobody can log in.
- The frontend and API should share a site (same domain, or sibling subdomains of one domain).
  If they end up on different sites, set `COOKIE_SAMESITE=none`, and add CSRF protection first.
