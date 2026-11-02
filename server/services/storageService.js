'use strict';
// Saves, finds and deletes uploaded images (FR#60, SC#7). Everything else in the app
// talks to this file, never to the disk directly, so moving to cloud storage later (TBD-2)
// only changes this file.
//
// Safety rules enforced here:
//  - the stored name is random; nothing the person typed (file name, folder) is used
//  - only whitelisted folders and only .jpg/.png are accepted
//  - a key is checked against a strict pattern before it ever touches the file system, so
//    "../" tricks cannot escape the upload folder
//  - files are written without execute permission and are only ever served as images
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { uploadDir, FOLDERS } = require('../config/storage');

const FOLDER_NAMES = Object.values(FOLDERS);
const CONTENT_TYPES = Object.freeze({ jpg: 'image/jpeg', png: 'image/png' });
const KEY_PATTERN = new RegExp(
  `^(${FOLDER_NAMES.join('|')})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png)$`
);

function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function resolvePath(key) {
  if (!isValidKey(key)) throw new Error('Invalid storage key');
  const fullPath = path.resolve(uploadDir, key);
  if (!fullPath.startsWith(uploadDir + path.sep)) throw new Error('Invalid storage key');
  return fullPath;
}

// Returns the key to store in the database (venue_photos.storage_key, users.profile_picture_key).
async function saveImage({ folder, buffer, extension }) {
  if (!FOLDER_NAMES.includes(folder)) throw new Error(`Unknown upload folder "${folder}"`);
  if (!CONTENT_TYPES[extension]) throw new Error(`Unsupported image type "${extension}"`);

  const key = `${folder}/${crypto.randomUUID()}.${extension}`;
  const fullPath = resolvePath(key);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  // 'wx' = never overwrite an existing file. 0o640 = no execute permission for anyone.
  await fs.writeFile(fullPath, buffer, { flag: 'wx', mode: 0o640 });
  return key;
}

// Safe to call for a file that is already gone.
async function deleteImage(key) {
  try {
    await fs.unlink(resolvePath(key));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// What the frontend uses in <img src>. Relative to the API's address.
function urlFor(key) {
  return isValidKey(key) ? `/api/files/${key}` : null;
}

function contentTypeFor(key) {
  return CONTENT_TYPES[path.extname(key).slice(1)];
}

module.exports = {
  FOLDERS,
  isValidKey,
  saveImage,
  deleteImage,
  urlFor,
  contentTypeFor,
  uploadDir,
};
