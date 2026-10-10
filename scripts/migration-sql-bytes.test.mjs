import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMigrationSql } from './migration-sql-bytes.mjs';
test('normalization changes only newline encoding, and is idempotent', () => {
  const lf = "-- 'Fictional, not approval'\nselect 'x';\n";
  for (const text of [lf, lf.replaceAll('\n', '\r\n'), lf.replaceAll('\n', '\r')]) {
    assert.equal(normalizeMigrationSql(text), lf);
    assert.equal(normalizeMigrationSql(normalizeMigrationSql(text)), lf);
  }
});
test('preserves spaces, Unicode, quotes, hashes and missing final newline', () => {
  assert.equal(normalizeMigrationSql("  select 'α';"), "  select 'α';");
});
test('non-string SQL is refused', () => {
  for (const input of [null, undefined, {}, Buffer.from('select 1')]) assert.throws(() => normalizeMigrationSql(input), /migration_sql_text_refused/);
});
