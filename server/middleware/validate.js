'use strict';
// validate({ body, query, params }): checks the request against zod schemas.
//  - Success: the cleaned values (trimmed, unknown fields removed) are put on
//    req.validated.body / .query / .params. Read them from there, not from req.body.
//  - Failure: a ValidationError with ONE message per invalid field (FR#3, FR#63).
// Schemas may contain async checks (e.g. "is this email already taken?").
const { ValidationError } = require('../utils/httpExceptions');

function toDetails(issues) {
  const seen = new Set();
  const details = [];
  for (const issue of issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
    if (seen.has(field)) continue; // keep the first (most basic) problem per field
    seen.add(field);
    details.push({ field, message: issue.message });
  }
  return details;
}

function validate(schemas) {
  return async (req, res, next) => {
    const validated = {};
    const details = [];

    for (const key of ['body', 'query', 'params']) {
      const schema = schemas[key];
      if (!schema) continue;

      let input = req[key];
      // With Express 5, req.body is undefined when no body was sent; arrays and
      // primitives are never valid bodies for our endpoints.
      if (key === 'body' && (input === null || typeof input !== 'object' || Array.isArray(input))) {
        input = {};
      }

      const result = await schema.safeParseAsync(input);
      if (result.success) {
        validated[key] = result.data;
      } else {
        details.push(...toDetails(result.error.issues));
      }
    }

    if (details.length > 0) throw new ValidationError(undefined, details);
    req.validated = validated;
    next();
  };
}

module.exports = validate;
