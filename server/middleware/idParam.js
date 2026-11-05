'use strict';
// Checks a ":id" in a URL before any route runs. Use once per router:
//   router.param('id', idParam);
// A value that cannot be a real id (abc, 0, -1, 1.5, or too big for a database INTEGER)
// is answered with 404, exactly like an id that does not exist, and never reaches the database.
const { NotFoundError } = require('../utils/httpExceptions');

const MAX_ID = 2147483647; // largest value an INTEGER column can hold

function idParam(req, res, next, value) {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > MAX_ID) {
    return next(new NotFoundError('Not found'));
  }
  return next();
}

module.exports = idParam;
