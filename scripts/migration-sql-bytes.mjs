/** The historical release is LF-normalized. Worktrees created before the
 * attributes were introduced can retain CRLF even after a clean branch switch.
 * Normalize before hashing and shipping, never by accepting an alternate hash. */
export function normalizeMigrationSql(text) {
  if (typeof text !== 'string') throw Error('migration_sql_text_refused');
  return text.replace(/\r\n?/g, '\n');
}
