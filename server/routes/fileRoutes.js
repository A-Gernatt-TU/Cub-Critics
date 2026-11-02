'use strict';
// GET /api/files/:folder/:name serves uploaded images (profile pictures, venue photos).
// Public, like the pages they appear on. It sits in front of the session and body parsing
// middleware in app.js because it needs neither.
//
// The name is checked against the same strict pattern used when saving, so the only files
// that can be reached are ones this app wrote.
const express = require('express');
const storageService = require('../services/storageService');
const { NotFoundError } = require('../utils/httpExceptions');

const router = express.Router();

router.get('/:folder/:name', async (req, res) => {
  const key = `${req.params.folder}/${req.params.name}`;
  if (!storageService.isValidKey(key)) throw new NotFoundError('File not found');

  try {
    await new Promise((resolve, reject) => {
      res.sendFile(
        key,
        {
          root: storageService.uploadDir,
          dotfiles: 'deny',
          // Applied only when the file is really being sent, so an error response (for
          // example a 404) is never labeled as an image.
          headers: {
            'Content-Type': storageService.contentTypeFor(key),
            'Content-Disposition': 'inline',
            // If anything other than a plain image ever ended up here, the browser still
            // would not run it (nosniff is also set globally by helmet).
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Content-Type-Options': 'nosniff',
            // The React app is on another origin and must be allowed to show these images.
            'Cross-Origin-Resource-Policy': 'cross-origin',
          },
          // Names are random and never reused, so a stored file never changes.
          maxAge: '365d',
          immutable: true,
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  } catch (err) {
    if (err.code === 'ENOENT' || err.status === 404) throw new NotFoundError('File not found');
    if (res.headersSent) return; // the visitor went away mid-download
    throw err;
  }
});

module.exports = router;
