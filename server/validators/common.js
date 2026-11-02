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
        issue.input === undefined ? `${label} is required` : `${label} must be text`,
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

module.exports = { safeText };
