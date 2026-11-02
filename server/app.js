'use strict';
// Builds the Express app and exports it WITHOUT listening, so tests can import it.
// server.js is what actually starts it.
//
// Added in later steps: rate limits and upload checks (security step), feature routes
// (endpoints step).
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config/env');
const routes = require('./routes');
const { sessionMiddleware } = require('./config/session');
const requestLogger = require('./middleware/requestLogger');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Needed so req.ip is the real client address behind a hosting proxy (AL#3, SC#6).
app.set('trust proxy', config.trustProxy);

app.use(requestLogger);
app.use(helmet()); // security headers (SC#1)

// Only the React app's origin(s) may call the API from a browser. Requests with no
// Origin header (curl, Postman, same-origin) are not affected by CORS.
app.use(
  cors({
    origin(origin, callback) {
      callback(null, !origin || config.allowedOrigins.includes(origin));
    },
    credentials: true, // lets the browser send the session cookie
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  })
);

// JSON only, with a small cap (image uploads use multer later, not this parser).
// Note: with Express 5, req.body is undefined when a request has no body.
app.use(express.json({ limit: '100kb' }));

// Login sessions (SC#5, SC#12). Guests never receive a cookie.
app.use(sessionMiddleware);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
