import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { withInventoryOperatorFence } from './adopted-plan-inventory-operator-fence';

const engines: PGlite[] = [];
afterEach(async () => { for (const pg of engines.splice(0)) await pg.close(); });
function fixture(name = 'clinical_core_qualification', deny = false) {
  const pg = new PGlite(); engines.push(pg); const queries: string[] = []; let expired = false;
  // PGlite's local database name alone is modeled. Advisory-lock SQL and
  // transactions really execute; lease loss is a named fictional fault.
  const db: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => work({ query: async (sql, args = []) => {
    queries.push(sql); if (expired) throw Error('fictional transport lease expired');
    if (sql === 'select current_database() as name') return { rows: [{ name }] };
    const result = await tx.query(sql, [...args]);
    return deny && sql.includes('pg_try_advisory') ? { rows: [{ acquired: false }] } : result;
  } } as ClinicalCoreTransaction)) };
  return { db, queries, expire: () => { expired = true; } };
}
describe('actual local SQL operator fence, not hosted lease evidence', () => {
  it('verifies the same transaction repeatedly without clinical DDL or DML', async () => {
    const f = fixture();
    expect(await withInventoryOperatorFence(f.db, async fence => { await fence.verify(); await fence.verify(); return 'observed'; })).toBe('observed');
    expect(f.queries.filter(q => q.includes('pg_try_advisory')).length).toBe(3);
    expect(f.queries.some(q => /^(create|alter|insert|update|delete)/i.test(q))).toBe(false);
  });
  it.each(['staging', 'busy', 'expired'])('refuses %s without recreating a fence', async kind => {
    const f = fixture(kind === 'staging' ? 'clinical_core' : undefined, kind === 'busy'); let entered = false;
    await expect(withInventoryOperatorFence(f.db, async fence => {
      entered = true; f.expire(); await fence.verify();
    })).rejects.toThrow();
    expect(entered).toBe(kind === 'expired');
    expect(f.queries.filter(q => q.startsWith('set local lock_timeout')).length).toBe(1);
  });
});
