/** Schema-derived pending disposition checks. Inventory is not deletion authority. */
export function immutableDispositionErrors(sql, entries) {
  const immutable = new Set([...sql.matchAll(/create\s+trigger\s+[a-z_]+\s+before\s+(?:update\s+or\s+delete|delete\s+or\s+update)\s+on\s+([a-z_]+\.[a-z_]+)\s+for\s+each\s+row\s+execute\s+function\s+clinical_private\.block_update_delete\s*\(\s*\)/gi)]
    .map(match => match[1].toLowerCase()));
  const errors = [];
  for (const entry of entries) {
    const valid = entry.scope !== 'retained' && entry.appendOnly === true && typeof entry.disposition === 'string'
      && entry.disposition.trim().length >= 20 && entry.disposition.length <= 2000;
    if (entry.scope !== 'retained' && immutable.has(entry.table) && !valid) {
      errors.push(`${entry.table} omits its immutable/pending-disposition boundary`);
    }
    if ((entry.appendOnly !== undefined || entry.disposition !== undefined) && !valid) {
      errors.push(`${entry.table} carries malformed immutable/disposition metadata`);
    }
  }
  return errors;
}
