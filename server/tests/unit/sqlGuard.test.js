// Guardrail for SC#4: SQL must never be built by pasting values into a string.
// Values go in through `replacements` / `bind` (or Sequelize's own query builder).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.git', 'coverage', 'uploads', 'tests']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// Returns a description of each risky query call found in `source`.
function findUnsafeQueries(source) {
  const problems = [];
  const flagged = new Set(); // templates already reported, so each is reported once
  // query(`... ${value} ...`)  or  literal(`... ${value} ...`)
  for (const match of source.matchAll(/\.(?:query|literal)\(\s*`([^`]*)`/g)) {
    if (match[1].includes('${')) {
      flagged.add(match[1]);
      problems.push(`interpolated template: ${match[1].slice(0, 60)}`);
    }
  }
  // query('SELECT ...' + value)
  for (const match of source.matchAll(/\.(?:query|literal)\(\s*(['"])[^'"]*\1\s*\+/g)) {
    problems.push(`string concatenation: ${match[0].slice(0, 60)}`);
  }
  // Any backtick string that looks like SQL and has ${...} in it, wherever it is used. This
  // also catches SQL assembled into a variable first and passed to query() later.
  for (const match of source.matchAll(/`([^`]*)`/g)) {
    const text = match[1];
    if (flagged.has(text)) continue;
    if (
      text.includes('${') &&
      /\b(SELECT\b.*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/is.test(text)
    ) {
      problems.push(`SQL-looking template with interpolation: ${text.slice(0, 60)}`);
    }
  }
  return problems;
}

describe('no SQL built from strings (SC#4)', () => {
  test('the detector itself catches the dangerous patterns', () => {
    expect(
      findUnsafeQueries('sequelize.query(`SELECT * FROM users WHERE id = ${id}`)')
    ).toHaveLength(1);
    expect(findUnsafeQueries("db.query('SELECT * FROM users WHERE id = ' + id)")).toHaveLength(1);
    expect(findUnsafeQueries('sequelize.literal(`x = ${y}`)')).toHaveLength(1);
    expect(
      findUnsafeQueries('sequelize.query(`SELECT 1 WHERE id = :id`, { replacements: { id } })')
    ).toHaveLength(0);
    // SQL built into a variable first is caught too
    expect(
      findUnsafeQueries('const sql = `SELECT * FROM venues WHERE name = ${name}`; db.query(sql)')
    ).toHaveLength(1);
    expect(findUnsafeQueries('const sql = `DELETE FROM users WHERE id = ${id}`;')).toHaveLength(1);
    // ordinary strings with ${} that are not SQL are fine
    expect(
      findUnsafeQueries('const message = `Hello ${name}, you selected a venue`;')
    ).toHaveLength(0);
    expect(findUnsafeQueries('const p = `%${text}%`;')).toHaveLength(0);
  });

  test('no application, migration or seeder file contains one', () => {
    const files = sourceFiles(ROOT);
    // Make sure the scan is real: it must cover the places that actually run SQL.
    const names = files.map((f) => path.relative(ROOT, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'services/authService.js',
        'services/sessionService.js',
        'migrations/20261026000100-create-users.js',
        'seeders/20261026010400-demo-venues.js',
      ])
    );

    const offenders = files.flatMap((file) =>
      findUnsafeQueries(fs.readFileSync(file, 'utf8')).map(
        (problem) => `${path.relative(ROOT, file)}: ${problem}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
