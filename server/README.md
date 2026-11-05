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

## API: venues, reviews, profiles, administration

All paths start with `/api`. Send `credentials: 'include'` so the session cookie goes along.
Lists return `{ items..., total }`; errors use the shape described under Conventions.

### Public (no login needed, FR#9)

| Endpoint                      | Purpose                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /categories`             | `{ categories: [{ id, name }] }` for the filter menu                                                                                                                                                                                                                                                                                 |
| `GET /venues`                 | The directory. Query: `q` (venue name **or** menu item), `category=1,2`, `minRating=4`, `openNow=true`, `sort=name\|rating`, `limit`. All filters apply together. Returns `{ venues, total }`; with `q`, each venue has `matchedMenuItems`. Home page "top rated": `?sort=rating&limit=5`. No matches is `{ venues: [], total: 0 }`. |
| `GET /venues/:id`             | One venue: `description`, `location`, `category`, `avgRating`, `reviewCount`, `openStatus`, `hours` (7 days, Sunday first), `specialHours` (holidays, next 60 days), `photos`, `menu: { notice, items }`. Show `menu.notice` with every menu (SF#3). `photos: []` means show your placeholder image (FR#22).                         |
| `GET /venues/:id/reviews`     | `?sort=newest\|oldest\|highest\|lowest&limit=20&offset=0`. `mine: true` marks the logged-in student's own review.                                                                                                                                                                                                                    |
| `GET /users/:id`              | A student's public profile: username, picture, bio, join date, review count, badges. Never an email.                                                                                                                                                                                                                                 |
| `GET /users/:id/reviews`      | Their public reviews, with the venue. Paged.                                                                                                                                                                                                                                                                                         |
| `GET /reviews/report-reasons` | `[{ value, label }]` for the report form                                                                                                                                                                                                                                                                                             |
| `GET /files/...`              | The image URLs the API returns (put them in `<img src>`, prefixed with the API address)                                                                                                                                                                                                                                              |

`avgRating` is one decimal (or `null` when unrated); only visible reviews count. `openStatus` is
`{ isOpen, closesAt: "20:00" | null, nextOpen: { dayOfWeek, time, isToday } | null }`, judged in US Eastern time.
Prices are numbers. Times are `"HH:MM"` (24-hour).

### Students (login required)

| Endpoint                       | Purpose                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /venues/:id/reviews`     | `{ rating: 1-5, body?: text up to 1000 }` -> `201 { review, newAchievements }`. `newAchievements` lists any badge this review just earned. |
| `GET /venues/:id/reviews/mine` | My review of this venue, or `{ review: null }`. If it exists, open it for editing instead of a blank form (FR#27).                         |
| `PATCH /reviews/:id`           | `{ rating?, body? }`; `body: null` removes the text. Marks the review `edited`.                                                            |
| `DELETE /reviews/:id`          | `204`. Ask "are you sure?" first (FR#62).                                                                                                  |
| `POST /reviews/:id/report`     | `{ reason, comment? }` -> `201`. Not your own review; once per review.                                                                     |
| `GET /users/me/reviews`        | My history, newest first, each with its `status` (`published`, `reported`, `flagged`, `removed`) (FR#14)                                   |
| `PATCH /users/me`              | `{ bio }` up to 250 characters; `null` clears it. Returns the account.                                                                     |
| `PUT /users/me/picture`        | `multipart/form-data`, field `file`, JPG/PNG up to 2 MB. Returns the account with `profilePictureUrl`.                                     |

A review a moderator flagged or removed can no longer be edited or deleted by its author, and a student
whose review was removed cannot post another for that venue.

### Administrators (everything under `/admin`; guests get 401, students get 403)

| Endpoint                                                           | Purpose                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/dashboard`                                             | `{ awaitingModeration, reportedReviews, flaggedReviews, openReports, venues: { active, inactive } }`                                                               |
| `GET /admin/moderation/queue`                                      | `?status=reported\|flagged&limit&offset`. Each item: the review, its author, venue, and its open reports (reason, comment, reporter, date). Longest-waiting first. |
| `POST /admin/reviews/:id/approve`                                  | `{ reason? }`. Back to published; reports closed.                                                                                                                  |
| `POST /admin/reviews/:id/flag`                                     | `{ reason? }`. Hidden from the public immediately, pending a decision.                                                                                             |
| `POST /admin/reviews/:id/remove`                                   | `{ reason }` (**required**). Hidden for good, reports closed.                                                                                                      |
| `GET /admin/venues`, `GET /admin/venues/:id`                       | All venues including deactivated, with counts / one venue with its `status` and every upcoming holiday date                                                        |
| `POST /admin/venues`                                               | `{ name, categoryId, description, location, hours, specialHours? }`                                                                                                |
| `PATCH /admin/venues/:id`                                          | Any of those. **`hours` and `specialHours` replace the whole list**, so send everything to keep (the admin `GET` returns it all).                                  |
| `POST /admin/venues/:id/deactivate` / `reactivate`                 | Hide from the directory and search, keeping its reviews / bring it back                                                                                            |
| `POST /admin/venues/:id/menu-items`                                | `{ name, description?, price }`                                                                                                                                    |
| `PATCH` / `DELETE /admin/menu-items/:id`                           | Edit / remove an item                                                                                                                                              |
| `POST /admin/venues/:id/photos`                                    | `multipart/form-data`, field `file`, JPG/PNG up to 5 MB, at most 15 per venue                                                                                      |
| `DELETE /admin/photos/:id`                                         | Remove a photo (and its file)                                                                                                                                      |
| `POST /admin/categories`, `PATCH` / `DELETE /admin/categories/:id` | Manage categories; one that venues use cannot be deleted                                                                                                           |

Hours format: `[{ dayOfWeek: 1, opensAt: "07:00", closesAt: "20:00" }, { dayOfWeek: 0, isClosed: true }]`
(0 = Sunday). A day with no entry is closed. A closing time at or before the opening time runs past
midnight (`18:00`-`02:00`). Several periods per day are fine; overlapping ones are refused. `specialHours` entries
add `date: "2026-11-26"` (and an optional `note`) and replace the weekly hours for that date only.

Every administrator change is written to the audit log together with the change itself (one database
transaction), and every moderation decision to the moderation log (AL#1, AL#2, FR#59).

### More error codes the frontend should handle

| Status | `error.code`                                          | When                                                          |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------- |
| 403    | `ORIGIN_NOT_ALLOWED`                                  | request came from a site that is not in `ALLOWED_ORIGINS`     |
| 409    | `REVIEW_ALREADY_EXISTS`                               | `details: { reviewId }`: edit that review instead             |
| 409    | `REVIEW_REMOVED`                                      | a moderator removed this student's review of the venue        |
| 409    | `REVIEW_LOCKED`                                       | the review is with a moderator (flagged or removed)           |
| 400    | `CANNOT_REPORT_OWN_REVIEW`                            |                                                               |
| 409    | `REPORT_ALREADY_FILED`                                |                                                               |
| 409    | `REVIEW_NOT_ACTIONABLE`                               | admin: the review is not in a state that allows this decision |
| 409    | `CATEGORY_IN_USE`, `MENU_FULL`, `PHOTO_LIMIT_REACHED` | admin limits                                                  |
| 429    | `TOO_MANY_REQUESTS`                                   | rate limit; see the `Retry-After` header                      |
| 400    | `INVALID_INPUT`                                       | a request contained characters that are never allowed         |

An id in a URL that cannot exist (`abc`, `0`, `-1`) is a 404, like one that does not exist.

### Requirements coverage

| Requirements                    | Where                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| FR#1-FR#10, FR#53               | Authentication, roles, users table                                     |
| FR#11-FR#16, FR#58              | Profiles, bio, picture, badges                                         |
| FR#17-FR#23                     | `GET /venues`, `GET /venues/:id`                                       |
| FR#24-FR#31                     | Reviews and reports                                                    |
| FR#32-FR#39                     | `GET /venues` query                                                    |
| FR#40-FR#44, FR#59              | Dashboard and moderation                                               |
| FR#45-FR#52, FR#54-FR#57, FR#60 | Venue, menu and photo management; data and image storage               |
| FR#63                           | Validation on every endpoint                                           |
| FR#17 (text), FR#61, FR#62      | Frontend: home page copy, Terms/Privacy pages, "are you sure?" dialogs |

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
