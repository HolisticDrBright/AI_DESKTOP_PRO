import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { bindCareMessagingDatabase } from './care-messaging-deployment';
import { bindCareConnectionDatabase, type CareConnectionFunctionBinding } from './care-connections-database-binding';
import { bindCareClaimRecoveryDatabase } from './care-claim-recovery-database-binding';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';

// The actual 107 SQL executes locally. No hosted qualification or approval claim.
let pg: PGlite;
let messagePins: { schema: string; name: string; sha256: string; callable: boolean }[];
let connectionPins: CareConnectionFunctionBinding[], claimPins: CareConnectionFunctionBinding[];
const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: (sql: string, args: unknown[] = []) => tx.query(sql, args) } as ClinicalCoreTransaction);
}) };
beforeAll(async () => {
  const a = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }));
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  pg = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql: string, args: unknown[] = []) => tx.query(sql, args) } as ClinicalCoreTransaction)) };
  await applyProductionClinicalCoreMigrations(admin, a.manifest.migrations.map((m: { version: string; file: string }) => ({
    version: m.version, name: m.file.slice(15, -4), sql: a.files[m.file], sha256: sha(a.files[m.file]),
  })));
  messagePins = [...a.files['20261006010000_production_care_messaging.sql'].matchAll(
    /create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
    .map(([, schema, name, body]) => ({ schema, name, sha256: sha(body), callable: schema === 'clinical_core' }));
  const pins = (sql: string) => [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
    .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
  connectionPins = pins(a.files['20261006020000_production_care_connections.sql']);
  claimPins = pins(a.files['20261006030000_production_care_claim_recovery.sql']);
}, 60000);
afterAll(async () => { await pg?.close(); });
describe('107 care contract compatibility (real embedded SQL, not AWS)', () => {
  it('has exactly the successor ledger without any seeded clinical rows', async () => {
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.schema_migrations')).rows[0].n).toBe(107);
    expect((await pg.query<{ n: number }>('select count(*)::int n from clinical_core.persons')).rows[0].n).toBe(0);
  });
  it.each(['messaging', 'connections', 'claim-recovery'] as const)('retains %s privileges, immutable guards and compiled function bodies', async kind => {
    const guarded = kind === 'messaging' ? bindCareMessagingDatabase(database, { functions: messagePins })
      : kind === 'connections' ? bindCareConnectionDatabase(database, connectionPins)
        : bindCareClaimRecoveryDatabase(database, connectionPins, claimPins);
    expect(await guarded.transaction(async tx => (await tx.query<{ actor: string }>('select current_user as actor')).rows[0].actor)).toBe('clinical_core_api');
  });
  it('does not admit an administrative connection as an API data client', async () => {
    const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql: string, args: unknown[] = []) => tx.query(sql, args) } as ClinicalCoreTransaction)) };
    let entered = false;
    await expect(bindCareMessagingDatabase(admin, { functions: messagePins }).transaction(async () => { entered = true; })).rejects.toThrow('service_unavailable');
    expect(entered).toBe(false);
  });
  it('refuses a successor with changed function digest even when table and ledger counts agree', async () => {
    let entered = false;
    const changed = messagePins.map((p, i) => i ? p : { ...p, sha256: 'f'.repeat(64) });
    await expect(bindCareMessagingDatabase(database, { functions: changed }).transaction(async () => { entered = true; })).rejects.toThrow('service_unavailable');
    expect(entered).toBe(false);
  });
});
