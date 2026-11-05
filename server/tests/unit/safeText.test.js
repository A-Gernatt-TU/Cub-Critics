const { safeText } = require('../../validators/common');

const check = (schema, value) => schema.safeParse(value);
const message = (result) => result.error.issues[0].message;

describe('safeText (SC#4)', () => {
  const bio = safeText('Bio', { max: 10 });
  const review = safeText('Review', { max: 20, multiline: true });

  test('trims, normalizes to NFC, and returns the clean value', () => {
    expect(check(bio, '  hi  ').data).toBe('hi');
    expect(check(bio, 'e\u0301').data).toBe('\u00e9'); // e + combining accent -> é
  });

  test('says what is wrong in plain language', () => {
    expect(message(check(bio, undefined))).toBe('Bio is required');
    expect(message(check(bio, null))).toBe('Bio is required');
    expect(message(check(bio, 42))).toBe('Bio must be text');
    expect(message(check(bio, 'x'.repeat(11)))).toBe('Bio must be 10 characters or fewer');
    expect(message(check(safeText('Name', { min: 3, max: 9 }), 'ab'))).toBe(
      'Name must be at least 3 characters'
    );
    expect(message(check(safeText('Name', { min: 1, max: 9 }), '   '))).toBe('Name is required');
  });

  test('counts characters the way the database does: an emoji is one character', () => {
    expect(check(bio, '😀'.repeat(10)).success).toBe(true);
    expect(check(bio, '😀'.repeat(11)).success).toBe(false);
  });

  test.each([
    ['NUL byte', 'a\u0000b'],
    ['bell character', 'a\u0007b'],
    ['escape character', 'a\u001bb'],
    ['line separator', 'a\u2028b'],
    ['C1 control', 'a\u0085b'],
  ])('rejects %s everywhere', (_label, value) => {
    expect(check(bio, value).success).toBe(false);
    expect(check(review, value).success).toBe(false);
    expect(message(check(bio, value))).toBe('Bio contains characters that are not allowed');
  });

  test.each([
    ['right-to-left override', 'abc\u202Edef'],
    ['left-to-right embedding', 'abc\u202Adef'],
    ['isolate', 'abc\u2066def'],
  ])('rejects the hidden text-direction trick: %s', (_label, value) => {
    expect(check(bio, value).success).toBe(false);
    expect(check(review, value).success).toBe(false);
  });

  test('line breaks and tabs: refused in single-line fields, allowed in multi-line fields', () => {
    expect(check(bio, 'a\nb').success).toBe(false);
    expect(check(bio, 'a\tb').success).toBe(false);
    expect(check(review, 'a\nb\tc').data).toBe('a\nb\tc');
  });

  test('Windows line breaks are converted to \\n in multi-line fields', () => {
    expect(check(review, 'a\r\nb\rc').data).toBe('a\nb\nc');
  });

  test('ordinary text in many languages and symbols passes untouched', () => {
    for (const text of [
      'Great pizza! 🍕',
      'Très bon',
      '美味しい',
      'مرحبا',
      "O'Brien & <b>Sons</b>",
    ]) {
      expect(check(safeText('Review', { max: 50 }), text).data).toBe(text);
    }
  });

  test('HTML is left as plain text (the frontend escapes it; the API never builds HTML)', () => {
    expect(check(bio, '<b>x</b>').data).toBe('<b>x</b>');
  });
});
