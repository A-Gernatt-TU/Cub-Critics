'use strict';
/* eslint-disable no-control-regex -- matching control characters is the purpose of this file */
// Shared building blocks for validating text that people type and OTHER people read
// (bios, reviews, report comments, venue text). Use `safeText` for all of them (SC#4).
const { z } = require('zod');

// Control characters are never legitimate in typed text. Multi-line fields may keep
// tab and line breaks.
const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
// Invisible text-direction overrides let someone make text display differently from what it
// says (for example reversing part of a sentence); there is no reason to allow them.
const DIRECTION_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/;

const codePoints = (text) => [...text].length;

/**
 * safeText('Review', { max: 1000, multiline: true })
 * Trims, normalizes Unicode (NFC), converts Windows line breaks, and rejects control
 * characters and direction overrides. Length is counted in characters (emoji count as one),
 * the same way the database counts. Wrap with .optional() or .nullish() when not required.
 */
function safeText(label, { min = 0, max, multiline = false } = {}) {
  let schema = z
    .string({
      error: (issue) =>
        issue.input === undefined || issue.input === null
          ? `${label} is required`
          : `${label} must be text`,
    })
    .trim()
    .normalize('NFC')
    .overwrite((text) => (multiline ? text.replace(/\r\n?/g, '\n') : text))
    .refine((text) => !(multiline ? CONTROL_MULTI_LINE : CONTROL_SINGLE_LINE).test(text), {
      error: `${label} contains characters that are not allowed`,
    })
    .refine((text) => !DIRECTION_OVERRIDES.test(text), {
      error: `${label} contains characters that are not allowed`,
    });

  if (min > 0) {
    schema = schema.refine((text) => codePoints(text) >= min, {
      error: min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`,
    });
  }
  if (max) {
    schema = schema.refine((text) => codePoints(text) <= max, {
      error: `${label} must be ${max} characters or fewer`,
    });
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Query-string helpers. Everything in a URL query arrives as text, so these turn it into
// numbers/booleans/lists and say what is wrong in plain words. A blank value (?q=) counts as
// "not given".
// ---------------------------------------------------------------------------
const MAX_ID = 2147483647;

const optionalQuery = (schema) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

function queryText(label, { max }) {
  return optionalQuery(
    z
      .string({ error: `${label} must be text` })
      .trim()
      .max(max, `${label} must be ${max} characters or fewer`)
      .transform((text) => text || undefined)
  );
}

function queryInteger(label, { min, max }) {
  return optionalQuery(
    z
      .string({ error: `${label} must be a whole number` })
      .trim()
      .regex(/^\d+$/, `${label} must be a whole number`)
      .transform(Number)
      .pipe(
        z
          .number()
          .min(min, `${label} must be at least ${min}`)
          .max(max, `${label} must be at most ${max}`)
      )
  );
}

function queryNumber(label, { min, max }) {
  return optionalQuery(
    z
      .string({ error: `${label} must be a number` })
      .trim()
      .regex(/^\d+(\.\d+)?$/, `${label} must be a number`)
      .transform(Number)
      .pipe(
        z
          .number()
          .min(min, `${label} must be at least ${min}`)
          .max(max, `${label} must be at most ${max}`)
      )
  );
}

function queryBoolean(label) {
  return optionalQuery(
    z
      .string({ error: `${label} must be true or false` })
      .trim()
      .toLowerCase()
      .refine((v) => ['true', 'false', '1', '0'].includes(v), `${label} must be true or false`)
      .transform((v) => v === 'true' || v === '1')
  );
}

function queryEnum(label, values) {
  return optionalQuery(z.enum(values, { error: `${label} must be one of: ${values.join(', ')}` }));
}

// "1,2,3" or a repeated ?category=1&category=2 -> [1, 2, 3]
function queryIdList(label, { maxItems = 50 } = {}) {
  const message = `${label} must be a list of ids`;
  const isId = (v) => /^[1-9]\d{0,9}$/.test(v) && Number(v) <= MAX_ID;
  return optionalQuery(
    z
      .union([z.string(), z.array(z.string())], { error: message })
      .transform((value) =>
        (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim())
      )
      .pipe(
        z
          .array(z.string())
          .max(maxItems, `${label} can list at most ${maxItems} ids`)
          .refine((list) => list.every(isId), message)
          .transform((list) => list.map(Number))
      )
  );
}

module.exports = {
  safeText,
  queryText,
  queryInteger,
  queryNumber,
  queryBoolean,
  queryEnum,
  queryIdList,
};
