'use strict';
// Image upload checks (SC#7, FR#13, FR#51). Use it as a route middleware:
//
//   router.put('/me/picture', requireAuth, ...uploadImage({ maxBytes: 2 * 1024 * 1024 }), handler)
//
// After it runs, `req.image` is { buffer, extension: 'jpg' | 'png', size, originalFilename }.
// The handler then calls storageService.saveImage(...) with it.
//
// What it guarantees:
//  - exactly one file, in a field named "file", no other form fields
//  - at most `maxBytes` (the file is cut off while uploading, not after)
//  - the file really IS a JPEG or PNG, judged by its first bytes. The file name and the
//    type the browser claims are never trusted, so a script renamed to "photo.png" is refused
const multer = require('multer');
const { ValidationError, BadRequestError } = require('../utils/httpExceptions');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Looks at the file's first bytes. Returns 'png', 'jpg' or null.
function detectImageType(buffer) {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.subarray(12, 16).toString('latin1') === 'IHDR'
  ) {
    return 'png';
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

// The original name is only kept as a label; never used to build a path.
function cleanFilename(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 100);
  return cleaned || 'image';
}

const fileError = (message) => new ValidationError(undefined, [{ field: 'file', message }]);

function uploadImage({ maxBytes, field = 'file', label = 'Image' }) {
  const megabytes = Math.floor((maxBytes / (1024 * 1024)) * 10) / 10;

  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2, headerPairs: 20 },
  }).single(field);

  const receive = (req, res, next) => {
    parse(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(fileError(`${label} must be ${megabytes} MB or smaller`));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return next(fileError(`Upload one image at a time, in the "${field}" field`));
      }
      if (err instanceof multer.MulterError) {
        return next(new BadRequestError('Invalid upload', { code: 'INVALID_UPLOAD' }));
      }
      // Malformed multipart data from the client (truncated body, bad boundary, ...)
      return next(new BadRequestError('Invalid upload', { code: 'INVALID_UPLOAD' }));
    });
  };

  const verify = (req, res, next) => {
    if (!req.file || req.file.size === 0)
      return next(fileError('Please choose an image to upload'));

    const extension = detectImageType(req.file.buffer);
    if (!extension) return next(fileError('Only JPG or PNG images are allowed'));

    req.image = {
      buffer: req.file.buffer,
      extension,
      size: req.file.size,
      originalFilename: cleanFilename(req.file.originalname),
    };
    return next();
  };

  return [receive, verify];
}

module.exports = { uploadImage, detectImageType, cleanFilename };
