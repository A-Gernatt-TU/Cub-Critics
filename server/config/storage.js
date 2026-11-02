'use strict';
// Image storage settings (FR#60, SC#7). The files live on local disk for now; the hosting
// platform is not chosen yet (TBD-2). Everything that touches stored files goes through
// services/storageService.js, so a cloud driver can be added later without changing the
// rest of the code.
const config = require('./env');

// The only folders images may be stored in. Anything else is refused.
const FOLDERS = Object.freeze({
  PROFILE_PICTURES: 'profile-pictures',
  VENUE_PHOTOS: 'venue-photos',
});

module.exports = Object.freeze({
  driver: config.storageDriver,
  uploadDir: config.uploadDir,
  FOLDERS,
});
