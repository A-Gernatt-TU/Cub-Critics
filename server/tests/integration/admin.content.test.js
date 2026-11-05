// Administrator menu items, photos and categories (FR#48-FR#52, SQ#6, AL#2).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubcritics-admin-uploads-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const app = require('../../app');
const { MenuItem, VenuePhoto, Category } = require('../../models');
const { resetDb, closeAll, loginAs, createCategory, createVenue, sequelize } = require('./helpers');

beforeEach(async () => {
  await resetDb();
  fs.rmSync(path.join(uploadDir, 'venue-photos'), { recursive: true, force: true });
});
afterAll(async () => {
  await closeAll();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

const MB = 1024 * 1024;
const png = (extra = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(20, 1),
    extra,
  ]);
const jpeg = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.from('JFIF'),
    Buffer.alloc(30, 1),
  ]);
const field = (res, name) => res.body.error.details.find((d) => d.field === name)?.message;
const events = async (prefix) =>
  (await sequelize.query('SELECT * FROM audit_log ORDER BY id'))[0].filter((r) =>
    r.event_type.startsWith(prefix)
  );
const files = () => {
  const dir = path.join(uploadDir, 'venue-photos');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const admin = () =>
  loginAs(app, {
    role: 'administrator',
    username: 'content_admin',
    email: 'content.admin@example.com',
  });

describe('menu items (FR#48, FR#49, FR#50)', () => {
  test('add: appears on the venue page with a numeric price, and is searchable', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue({ name: 'Menu Venue' });
    const res = await agent
      .post(`/api/admin/venues/${venue.id}/menu-items`)
      .send({ name: 'Chicken Wrap', description: 'Grilled chicken', price: 7.5 });

    expect(res.status).toBe(201);
    expect(res.body.item).toEqual({
      id: expect.any(Number),
      name: 'Chicken Wrap',
      description: 'Grilled chicken',
      price: 7.5,
    });
    const page = (await request(app).get(`/api/venues/${venue.id}`)).body.venue;
    expect(page.menu.items).toEqual([res.body.item]);
    expect((await request(app).get('/api/venues?q=wrap')).body.total).toBe(1);

    const [row] = await events('menu_item_created');
    expect(row).toMatchObject({
      actor_id: user.id,
      entity_id: res.body.item.id,
      details: { venueId: venue.id, name: 'Chicken Wrap' },
    });
  });

  test('the description is optional; prices of 0 and with cents are exact', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    const add = (body) => agent.post(`/api/admin/venues/${venue.id}/menu-items`).send(body);
    expect((await add({ name: 'Free Water', price: 0 })).body.item).toMatchObject({
      price: 0,
      description: null,
    });
    expect((await add({ name: 'Cookie', price: 1.1 })).body.item.price).toBe(1.1);
    expect((await add({ name: 'Special', price: 19.99, description: '' })).body.item).toMatchObject(
      { price: 19.99, description: null }
    );
    expect((await add({ name: 'Top', price: 9999.99 })).status).toBe(201);
  });

  test('bad names and prices are refused beside the field', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    const add = (body) => agent.post(`/api/admin/venues/${venue.id}/menu-items`).send(body);
    expect(field(await add({ price: 5 }), 'name')).toBe('Name is required');
    expect(field(await add({ name: 'x'.repeat(101), price: 5 }), 'name')).toBe(
      'Name must be 100 characters or fewer'
    );
    expect(field(await add({ name: 'x' }), 'price')).toBe('Price must be a number');
    for (const [price, message] of [
      [-1, 'Price cannot be negative'],
      [10000, 'Price must be $9,999.99 or less'],
      [3.999, 'Price can have at most two decimal places'],
      ['5', 'Price must be a number'],
      [null, 'Price must be a number'],
    ]) {
      expect(field(await add({ name: 'x', price }), 'price')).toBe(message);
    }
    expect(
      field(await add({ name: 'x', price: 1, description: 'x'.repeat(501) }), 'description')
    ).toBe('Description must be 500 characters or fewer');
    expect(await MenuItem.count()).toBe(0);
  });

  test('unknown, impossible and (for admins) deactivated venues', async () => {
    const { agent } = await admin();
    for (const id of [424242, 'abc', 0, 2147483648]) {
      expect(
        (await agent.post(`/api/admin/venues/${id}/menu-items`).send({ name: 'x', price: 1 }))
          .status
      ).toBe(404);
    }
    const hidden = await createVenue({ status: 'inactive' });
    expect(
      (
        await agent
          .post(`/api/admin/venues/${hidden.id}/menu-items`)
          .send({ name: 'Prep', price: 1 })
      ).status
    ).toBe(201); // admins may prepare a hidden venue
  });

  test('a venue holds at most 200 items', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    await MenuItem.bulkCreate(
      Array.from({ length: 200 }, (_, i) => ({ venue_id: venue.id, name: `Item ${i}`, price: 1 }))
    );
    const res = await agent
      .post(`/api/admin/venues/${venue.id}/menu-items`)
      .send({ name: 'One too many', price: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MENU_FULL');
  });

  test('edit: change the name, description and price, one at a time or together', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue({ menu: [['Burger', 9, 'Beef']] });
    const item = await MenuItem.findOne({ where: { venue_id: venue.id } });

    expect(
      (await agent.patch(`/api/admin/menu-items/${item.id}`).send({ price: 10.5 })).body.item
    ).toMatchObject({ name: 'Burger', price: 10.5, description: 'Beef' });
    expect(
      (
        await agent
          .patch(`/api/admin/menu-items/${item.id}`)
          .send({ name: 'Cheeseburger', description: 'With cheese' })
      ).body.item
    ).toMatchObject({ name: 'Cheeseburger', description: 'With cheese', price: 10.5 });
    expect(
      (await agent.patch(`/api/admin/menu-items/${item.id}`).send({ description: null })).body.item
        .description
    ).toBeNull();

    const rows = await events('menu_item_updated');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      actor_id: user.id,
      details: { venueId: venue.id, changed: ['price'] },
    });
  });

  test('edit: empty or invalid changes and unknown items are refused', async () => {
    const { agent } = await admin();
    const venue = await createVenue({ menu: ['Soup'] });
    const item = await MenuItem.findOne({ where: { venue_id: venue.id } });
    expect(field(await agent.patch(`/api/admin/menu-items/${item.id}`).send({}), 'name')).toBe(
      'Send at least one thing to change'
    );
    expect((await agent.patch(`/api/admin/menu-items/${item.id}`).send({ price: -5 })).status).toBe(
      400
    );
    expect(
      (
        await agent
          .patch(`/api/admin/menu-items/${item.id}`)
          .send({ venue_id: 999, name: 'Soup 2' })
      ).status
    ).toBe(200);
    expect((await MenuItem.findByPk(item.id)).venue_id).toBe(venue.id); // cannot be moved to another venue
    for (const id of [424242, 'abc', 0])
      expect((await agent.patch(`/api/admin/menu-items/${id}`).send({ name: 'x' })).status).toBe(
        404
      );
  });

  test('delete: removes the item and is audited', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue({ menu: ['Soup', 'Salad'] });
    const item = await MenuItem.findOne({ where: { venue_id: venue.id, name: 'Soup' } });
    expect((await agent.delete(`/api/admin/menu-items/${item.id}`)).status).toBe(204);
    expect(await MenuItem.findByPk(item.id)).toBeNull();
    expect(
      (await request(app).get(`/api/venues/${venue.id}`)).body.venue.menu.items.map((i) => i.name)
    ).toEqual(['Salad']);
    expect((await agent.delete(`/api/admin/menu-items/${item.id}`)).status).toBe(404);
    const [row] = await events('menu_item_deleted');
    expect(row).toMatchObject({ actor_id: user.id, details: { venueId: venue.id, name: 'Soup' } });
  });
});

describe('venue photos (FR#51, FR#52)', () => {
  const upload = (agent, venueId, buffer, filename = 'photo.png', fieldName = 'file') =>
    agent.post(`/api/admin/venues/${venueId}/photos`).attach(fieldName, buffer, filename);

  test('upload a PNG or JPG: it is stored, listed, served, and used as the directory thumbnail', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue({ name: 'Photo Venue' });
    const res = await upload(agent, venue.id, png());

    expect(res.status).toBe(201);
    expect(res.body.photo).toEqual({
      id: expect.any(Number),
      url: expect.stringMatching(/^\/api\/files\/venue-photos\/[0-9a-f-]{36}\.png$/),
    });
    const row = await VenuePhoto.findByPk(res.body.photo.id);
    expect(row).toMatchObject({
      venue_id: venue.id,
      uploaded_by: user.id,
      original_filename: 'photo.png',
      sort_order: 0,
    });

    expect((await request(app).get(`/api/venues/${venue.id}`)).body.venue.photos).toEqual([
      res.body.photo,
    ]);
    expect((await request(app).get('/api/venues')).body.venues[0].thumbnailUrl).toBe(
      res.body.photo.url
    );
    const img = await request(app).get(res.body.photo.url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);
    expect((await upload(agent, venue.id, jpeg(), 'b.jpg')).body.photo.url).toMatch(/\.jpg$/);
  });

  test('photos are ordered by upload, and audited', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue();
    const first = (await upload(agent, venue.id, png())).body.photo;
    const second = (await upload(agent, venue.id, png())).body.photo;
    expect((await VenuePhoto.findByPk(second.id)).sort_order).toBe(1);
    expect(
      (await request(app).get(`/api/venues/${venue.id}`)).body.venue.photos.map((p) => p.id)
    ).toEqual([first.id, second.id]);
    expect((await events('photo_added')).map((r) => r.actor_id)).toEqual([user.id, user.id]);
  });

  test('other files, oversize files and missing files are refused, and nothing is stored', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    const gif = await upload(agent, venue.id, Buffer.from('GIF89a' + 'x'.repeat(40)), 'a.gif');
    expect(field(gif, 'file')).toBe('Only JPG or PNG images are allowed');
    const svg = await upload(
      agent,
      venue.id,
      Buffer.from('<svg><script>alert(1)</script></svg>'),
      'a.png'
    );
    expect(field(svg, 'file')).toBe('Only JPG or PNG images are allowed');
    const big = await upload(agent, venue.id, png(Buffer.alloc(5 * MB + 10, 7)));
    expect(field(big, 'file')).toBe('Photo must be 5 MB or smaller');
    expect(field(await agent.post(`/api/admin/venues/${venue.id}/photos`), 'file')).toBe(
      'Please choose an image to upload'
    );
    expect(await VenuePhoto.count()).toBe(0);
    expect(files()).toHaveLength(0);
  });

  test('a photo just under 5 MB is accepted', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    expect((await upload(agent, venue.id, png(Buffer.alloc(5 * MB - 100, 7)))).status).toBe(201);
  });

  test('a venue holds at most 15 photos, and the refused file is not left on disk', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    for (let i = 0; i < 15; i += 1) {
      await VenuePhoto.create({
        venue_id: venue.id,
        storage_key: `venue-photos/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.png`,
        sort_order: i,
      });
    }
    const res = await upload(agent, venue.id, png());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHOTO_LIMIT_REACHED');
    expect(files()).toHaveLength(0);
    expect(await VenuePhoto.count()).toBe(15);
  });

  test('unknown venues give 404 and leave no file behind', async () => {
    const { agent } = await admin();
    for (const id of [424242, 'abc', 0]) expect((await upload(agent, id, png())).status).toBe(404);
    expect(files()).toHaveLength(0);
  });

  test('a database failure removes the just-saved file', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    await sequelize.query('ALTER TABLE audit_log RENAME TO audit_log_hidden');
    try {
      expect((await upload(agent, venue.id, png())).status).toBe(500);
    } finally {
      await sequelize.query('ALTER TABLE audit_log_hidden RENAME TO audit_log');
    }
    expect(files()).toHaveLength(0);
    expect(await VenuePhoto.count()).toBe(0);
  });

  test('remove: the row and the file are both deleted, and it is audited', async () => {
    const { agent, user } = await admin();
    const venue = await createVenue();
    const photo = (await upload(agent, venue.id, png())).body.photo;
    expect(files()).toHaveLength(1);

    expect((await agent.delete(`/api/admin/photos/${photo.id}`)).status).toBe(204);
    expect(await VenuePhoto.findByPk(photo.id)).toBeNull();
    expect(files()).toHaveLength(0);
    expect((await request(app).get(photo.url)).status).toBe(404);
    expect((await request(app).get(`/api/venues/${venue.id}`)).body.venue.photos).toEqual([]);
    expect((await events('photo_removed'))[0]).toMatchObject({
      actor_id: user.id,
      details: { venueId: venue.id },
    });
    expect((await agent.delete(`/api/admin/photos/${photo.id}`)).status).toBe(404);
  });

  test('removing a photo whose file is already gone still succeeds', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    const photo = (await upload(agent, venue.id, png())).body.photo;
    fs.rmSync(path.join(uploadDir, 'venue-photos'), { recursive: true, force: true });
    expect((await agent.delete(`/api/admin/photos/${photo.id}`)).status).toBe(204);
  });

  test('an upload cannot be forced from another website', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    const res = await agent
      .post(`/api/admin/venues/${venue.id}/photos`)
      .set('Origin', 'https://evil.example')
      .attach('file', png(), 'a.png');
    expect(res.status).toBe(403);
    expect(files()).toHaveLength(0);
  });
});

describe('categories (SQ#6)', () => {
  test('add, rename and list: the filter menu follows at once', async () => {
    const { agent, user } = await admin();
    const created = await agent.post('/api/admin/categories').send({ name: '  Food Truck  ' });
    expect(created.status).toBe(201);
    expect(created.body.category).toEqual({ id: expect.any(Number), name: 'Food Truck' });
    expect((await request(app).get('/api/categories')).body.categories.map((c) => c.name)).toEqual([
      'Food Truck',
    ]);

    const renamed = await agent
      .patch(`/api/admin/categories/${created.body.category.id}`)
      .send({ name: 'Food Trucks' });
    expect(renamed.body.category.name).toBe('Food Trucks');
    expect((await events('category_')).map((r) => [r.event_type, r.actor_id])).toEqual([
      ['category_created', user.id],
      ['category_updated', user.id],
    ]);
    expect((await events('category_updated'))[0].details).toEqual({
      from: 'Food Truck',
      to: 'Food Trucks',
    });
  });

  test('names must be unique ignoring letter case, and valid', async () => {
    const { agent } = await admin();
    await createCategory('Café');
    const dup = await agent.post('/api/admin/categories').send({ name: 'CAFÉ' });
    expect(dup.status).toBe(400);
    expect(field(dup, 'name')).toBe('A category with that name already exists');

    const other = await createCategory('Dining Hall');
    expect(
      field(await agent.patch(`/api/admin/categories/${other.id}`).send({ name: 'café' }), 'name')
    ).toBe('A category with that name already exists');
    expect(
      (await agent.patch(`/api/admin/categories/${other.id}`).send({ name: 'DINING HALL' })).status
    ).toBe(200); // changing only the letter case of its own name is fine

    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(51) },
      { name: 5 },
      { name: 'a\u0007b' },
    ]) {
      expect((await agent.post('/api/admin/categories').send(body)).status).toBe(400);
    }
  });

  test('two simultaneous requests for the same new name create one', async () => {
    const { agent } = await admin();
    const results = await Promise.all(
      [1, 2, 3].map(() => agent.post('/api/admin/categories').send({ name: 'Race' }))
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    expect(await Category.count()).toBe(1);
  });

  test('delete: an unused category goes; one that venues use is protected', async () => {
    const { agent, user } = await admin();
    const used = await createCategory('Used');
    const unused = await createCategory('Unused');
    await createVenue({ category: used });
    await createVenue({ category: used });

    const refused = await agent.delete(`/api/admin/categories/${used.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'CATEGORY_IN_USE',
      details: { venueCount: 2 },
    });
    expect(refused.body.error.message).toBe('2 venues use this category, so it cannot be deleted');
    expect(await Category.findByPk(used.id)).not.toBeNull();

    expect((await agent.delete(`/api/admin/categories/${unused.id}`)).status).toBe(204);
    expect(await Category.findByPk(unused.id)).toBeNull();
    expect((await events('category_deleted'))[0]).toMatchObject({
      actor_id: user.id,
      details: { name: 'Unused' },
    });
  });

  test('a deactivated venue still counts as using its category', async () => {
    const { agent } = await admin();
    const category = await createCategory('Held');
    await createVenue({ category, status: 'inactive' });
    expect((await agent.delete(`/api/admin/categories/${category.id}`)).body.error.message).toBe(
      '1 venue uses this category, so it cannot be deleted'
    );
  });

  test('unknown and impossible ids are 404', async () => {
    const { agent } = await admin();
    for (const id of [424242, 'abc', 0]) {
      expect((await agent.patch(`/api/admin/categories/${id}`).send({ name: 'x' })).status).toBe(
        404
      );
      expect((await agent.delete(`/api/admin/categories/${id}`)).status).toBe(404);
    }
  });
});

describe('audit log hygiene (AL#2)', () => {
  test('admin changes never record passwords, emails or session data', async () => {
    const { agent } = await admin();
    const venue = await createVenue();
    await agent.post(`/api/admin/venues/${venue.id}/menu-items`).send({ name: 'Item', price: 1 });
    await agent.post('/api/admin/categories').send({ name: 'Audit Cat' });
    const everything = JSON.stringify((await sequelize.query('SELECT * FROM audit_log'))[0]);
    expect(everything).not.toMatch(
      /password|content\.admin@example\.com|\$2[aby]\$|cubcritics\.sid/i
    );
  });
});
