// SC#7: image uploads and serving. Uses a throwaway folder, never the real uploads folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubcritics-uploads-'));
process.env.UPLOAD_DIR = uploadDir;

const express = require('express');
const request = require('supertest');
const { uploadImage, detectImageType, cleanFilename } = require('../../middleware/upload');
const storageService = require('../../services/storageService');
const fileRoutes = require('../../routes/fileRoutes');
const { errorHandler } = require('../../middleware/errorHandler');

const MB = 1024 * 1024;
const png = (extra = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(20, 1),
    extra,
  ]);
const jpeg = (extra = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.from('JFIF'),
    Buffer.alloc(30, 1),
    extra,
  ]);

const app = express();
app.use('/api/files', fileRoutes);
app.post('/t/upload', ...uploadImage({ maxBytes: 2 * MB }), async (req, res) => {
  const key = await storageService.saveImage({
    folder: storageService.FOLDERS.PROFILE_PICTURES,
    buffer: req.image.buffer,
    extension: req.image.extension,
  });
  res
    .status(201)
    .json({ key, url: storageService.urlFor(key), original: req.image.originalFilename });
});
app.use(errorHandler);

const upload = (buffer, filename = 'photo.png', field = 'file') =>
  request(app).post('/t/upload').attach(field, buffer, filename);
const storedFiles = () =>
  fs.readdirSync(path.join(uploadDir, 'profile-pictures'), { recursive: false }).filter(Boolean);
const field = (res) => res.body.error.details.find((d) => d.field === 'file')?.message;

afterAll(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
beforeEach(() =>
  fs.rmSync(path.join(uploadDir, 'profile-pictures'), { recursive: true, force: true })
);

describe('file type detection', () => {
  test('recognizes JPEG and PNG by their first bytes only', () => {
    expect(detectImageType(png())).toBe('png');
    expect(detectImageType(jpeg())).toBe('jpg');
  });

  test.each([
    ['GIF', Buffer.from('GIF89a' + 'x'.repeat(40))],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(40))],
    ['PHP', Buffer.from('<?php system($_GET["c"]); ?>' + ' '.repeat(40))],
    ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(40).fill(0)])],
    [
      'PNG signature but no header chunk',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(40),
      ]),
    ],
    ['truncated PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['one stray byte', Buffer.from([0xff])],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_label, buffer) => {
    expect(detectImageType(buffer)).toBeNull();
  });

  test('cleanFilename keeps only a harmless label', () => {
    expect(cleanFilename('../../../etc/passwd.png')).toBe('passwd.png');
    expect(cleanFilename('C:\\Users\\me\\pic.jpg')).toBe('pic.jpg');
    expect(cleanFilename('a\u0000b\u001f.png')).toBe('ab.png');
    expect(cleanFilename('x'.repeat(500)).length).toBe(100);
    expect(cleanFilename('')).toBe('image');
    expect(cleanFilename(undefined)).toBe('image');
  });
});

describe('uploadImage middleware', () => {
  test.each([
    ['PNG', png(), 'a.png', 'png'],
    ['JPEG', jpeg(), 'a.jpg', 'jpg'],
  ])(
    'accepts a real %s and stores it under a random name',
    async (_l, buffer, filename, extension) => {
      const res = await upload(buffer, filename);
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(new RegExp(`^profile-pictures/[0-9a-f-]{36}\\.${extension}$`));
      expect(res.body.url).toBe(`/api/files/${res.body.key}`);
      expect(fs.readFileSync(path.join(uploadDir, res.body.key)).equals(buffer)).toBe(true);
    }
  );

  test('the file type comes from the CONTENT, never from the file name', async () => {
    const asPhp = await upload(jpeg(), 'shell.php');
    expect(asPhp.status).toBe(201);
    expect(asPhp.body.key).toMatch(/\.jpg$/);
    const asJpg = await upload(png(), 'photo.jpg');
    expect(asJpg.body.key).toMatch(/\.png$/);
    expect(
      fs.readdirSync(path.join(uploadDir, 'profile-pictures')).every((n) => !/php/.test(n))
    ).toBe(true);
  });

  test('a file name full of "../" cannot choose where the file goes', async () => {
    const res = await upload(png(), '../../../../etc/cron.d/evil.png');
    expect(res.status).toBe(201);
    expect(res.body.original).toBe('evil.png');
    expect(res.body.key.startsWith('profile-pictures/')).toBe(true);
    expect(storedFiles()).toHaveLength(1);
    expect(fs.existsSync(path.join(uploadDir, '..', 'evil.png'))).toBe(false);
  });

  test('stored files have no execute permission', async () => {
    const res = await upload(png());
    const mode = fs.statSync(path.join(uploadDir, res.body.key)).mode;
    expect(mode & 0o111).toBe(0);
  });

  test.each([
    [
      'an SVG with a script',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'logo.png',
    ],
    ['a PHP script renamed .png', Buffer.from('<?php echo 1; ?>' + ' '.repeat(40)), 'photo.png'],
    [
      'an HTML page renamed .jpg',
      Buffer.from('<html><body onload=alert(1)></body></html>'),
      'photo.jpg',
    ],
    ['a GIF', Buffer.from('GIF89a' + 'x'.repeat(40)), 'photo.gif'],
  ])('refuses %s with the FR#13 message and stores nothing', async (_l, buffer, filename) => {
    const res = await upload(buffer, filename);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(field(res)).toBe('Only JPG or PNG images are allowed');
    expect(fs.existsSync(path.join(uploadDir, 'profile-pictures'))).toBe(false);
  });

  test('refuses files over the size limit, stopping the upload early, and stores nothing', async () => {
    const res = await upload(png(Buffer.alloc(2 * MB + 10, 7)));
    expect(res.status).toBe(400);
    expect(field(res)).toBe('Image must be 2 MB or smaller');
    expect(fs.existsSync(path.join(uploadDir, 'profile-pictures'))).toBe(false);
  });

  test('accepts a file just under the limit', async () => {
    const res = await upload(png(Buffer.alloc(2 * MB - 100, 7)));
    expect(res.status).toBe(201);
  });

  test('an empty file, or no file, asks for an image', async () => {
    expect(field(await upload(Buffer.alloc(0)))).toBe('Please choose an image to upload');
    const none = await request(app).post('/t/upload').send({ hello: 'world' });
    expect(none.status).toBe(400);
    expect(field(none)).toBe('Please choose an image to upload');
  });

  test('only one file, only in the "file" field', async () => {
    const wrongField = await upload(png(), 'a.png', 'avatar');
    expect(wrongField.status).toBe(400);
    expect(field(wrongField)).toBe('Upload one image at a time, in the "file" field');

    const two = await request(app)
      .post('/t/upload')
      .attach('file', png(), 'a.png')
      .attach('file', png(), 'b.png');
    expect(two.status).toBe(400);
    expect(fs.existsSync(path.join(uploadDir, 'profile-pictures'))).toBe(false);
  });

  test('extra text fields are refused', async () => {
    const res = await request(app)
      .post('/t/upload')
      .field('role', 'administrator')
      .attach('file', png(), 'a.png');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_UPLOAD');
  });

  test('a broken multipart body is a 400, never a crash', async () => {
    const res = await request(app)
      .post('/t/upload')
      .set('Content-Type', 'multipart/form-data; boundary=xyz')
      .send(
        '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n\r\ntruncated'
      );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeDefined();
  });
});

describe('GET /api/files/:folder/:name', () => {
  const saved = async (buffer) => (await upload(buffer)).body;

  test('serves an uploaded image with safe, cache-friendly headers', async () => {
    const original = png(Buffer.from('visible-payload'));
    const { url } = await saved(original);
    const res = await request(app)
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.body.equals(original)).toBe(true);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cache-control']).toMatch(/max-age=31536000.*immutable/);
  });

  test('a file with a script hidden after the image data is still only ever served as an image', async () => {
    const { url } = await saved(jpeg(Buffer.from('<script>alert(document.cookie)</script>')));
    const res = await request(app).get(url);
    expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  test('HEAD works', async () => {
    const { url } = await saved(png());
    expect((await request(app).head(url)).status).toBe(200);
  });

  test.each([
    ['dot-dot to another file', '/api/files/profile-pictures/..%2f..%2fpackage.json'],
    ['dot-dot in the folder', '/api/files/..%2f..%2f/x.png'],
    ['encoded dots', '/api/files/profile-pictures/%2e%2e%2f%2e%2e%2fconfig%2fenv.js'],
    ['double encoding', '/api/files/profile-pictures/%252e%252e%252fpackage.json'],
    ['backslashes', '/api/files/profile-pictures/..%5c..%5cpackage.json'],
    [
      'a folder that is not whitelisted',
      '/api/files/secrets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    ],
    [
      'a disallowed extension',
      '/api/files/profile-pictures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.php',
    ],
    ['a hidden file', '/api/files/profile-pictures/.env'],
    ['upper-case id', '/api/files/profile-pictures/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.png'],
    [
      'a valid-looking name that does not exist',
      '/api/files/profile-pictures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png',
    ],
    ['a null byte', '/api/files/profile-pictures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png%00.php'],
  ])('returns 404 for %s', async (_label, url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/); // an error is never labeled as an image
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toMatch(/ENOENT|\/tmp|node_modules/);
  });
});

describe('storageService', () => {
  test('only whitelisted folders and image types can be saved', async () => {
    await expect(
      storageService.saveImage({ folder: '../escape', buffer: png(), extension: 'png' })
    ).rejects.toThrow(/Unknown upload folder/);
    await expect(
      storageService.saveImage({ folder: 'profile-pictures', buffer: png(), extension: 'php' })
    ).rejects.toThrow(/Unsupported image type/);
  });

  test('deleting removes the file, and deleting twice is harmless', async () => {
    const { key } = (await upload(png())).body;
    expect(fs.existsSync(path.join(uploadDir, key))).toBe(true);
    await storageService.deleteImage(key);
    expect(fs.existsSync(path.join(uploadDir, key))).toBe(false);
    await expect(storageService.deleteImage(key)).resolves.toBeUndefined();
  });

  test('keys that could point outside the upload folder are refused before touching the disk', async () => {
    for (const key of [
      '../package.json',
      'profile-pictures/../../x.png',
      '/etc/passwd',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(storageService.isValidKey(key)).toBe(false);
      await expect(storageService.deleteImage(key)).rejects.toThrow(/Invalid storage key/);
    }
  });

  test('urlFor gives null for nothing, and a /api/files path for a real key', () => {
    expect(storageService.urlFor(null)).toBeNull();
    expect(storageService.urlFor('nonsense')).toBeNull();
    expect(storageService.urlFor('venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg')).toBe(
      '/api/files/venue-photos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg'
    );
  });
});
