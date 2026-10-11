import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { bindParameters } from './rds-data-database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { rehearseClinicPreservingTransition } from './clinic-preserving-rollback';
import { projectTelehealthSchema } from '../../../scripts/telehealth-schema-projection.mjs';
import { readClinicHistoricalRowWitness } from '../../../scripts/clinic-row-preservation.mjs';

// The fixed PGlite database name alone is modeled. Locks, row reads, metadata
// deltas, every source statement and physical rollback are actual SQL. No AWS,
// native lock interleaving, managed-schema admission or custody is proven.
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
let pg: PGlite, artifact: { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string> }, org: string;
type Hook = (sql: string, args: readonly unknown[], tx: ClinicalCoreTransaction) => Promise<void>;
const database = (hook?: Hook, name = 'clinical_core_qualification'): ClinicalCoreDatabase => ({ transaction: work => pg.transaction(tx => work({
  query: async (sql, args = []) => {
    bindParameters(sql, args);
    if (hook) await hook(sql, args, { query: (s, a = []) => tx.query(s, [...a]) });
    if (sql === 'select current_database() as name') return { rows: [{ name }] } as never;
    return tx.query(sql, [...args]);
  },
})) });
const witness = () => pg.transaction(tx => readClinicHistoricalRowWitness(tx, artifact, source));
const projection = () => projectTelehealthSchema((sql, args) => pg.query<{ name: string; digest: string }>(sql, [...args]));
const absent = async () => {
  expect((await pg.query<{ n: number; absent: boolean }>("select (select count(*)::int from clinical_core.schema_migrations) n,to_regclass('clinical_core.clinic_record_requests') is null absent")).rows[0])
    .toEqual({ n: 112, absent: true });
};
beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  pg = new PGlite({ extensions: { pgcrypto } });
  const migrations = artifact.manifest.migrations.map(r => ({ version: r.version, name: r.file.slice(15, -4), sql: artifact.files[r.file], sha256: sha(artifact.files[r.file]) }));
  const admin: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const row of migrations.slice(106, 112)) {
    await pg.exec(row.sql); await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.name, row.sha256]);
  }
  org = randomUUID(); const person = randomUUID();
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL rollback')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_clinic_rollback')", [person]);
  await pg.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)", [person]);
}, 120000);
afterAll(async () => { await pg?.close(); });

describe('fenced source-only clinic rollback kernel', () => {
  it('checks every prefix under both advisory fences and all table locks, then proves fresh physical rollback readback', async () => {
    const before = await witness(), schema = await projection(), queries: string[] = [];
    const result = await rehearseClinicPreservingTransition(database(async sql => { queries.push(sql); }), artifact, source);
    expect(result).toMatchObject({ contract: 'clinic-preserving-rollback/1', execution: 'source_rollback_only', checkedTransitions: 4,
      historicalTableCount: 217, historicalRowCount: 3, beforeMigrationCount: 112, rehearsedMigrationCount: 116,
      observedAfterRollbackCount: 112, rolledBack: true, ddlCommitted: false, canonicalSchemaAdmissionProven: false,
      custodyProven: false, managedRoleSemanticsVerified: false, operatorAcceptance: false, phiAllowed: false });
    expect(result.observedParentSchemaSha256).toBe(sha(JSON.stringify(schema)));
    expect(queries.filter(s => s.includes('pg_try_advisory_xact_lock'))).toHaveLength(2);
    const lock = queries.find(s => s.startsWith('lock table'))!;
    expect(lock).toContain('"clinical_private"."owned_legal_holds"');
    expect(lock.split(' in share row exclusive mode')[0].split(',')).toHaveLength(218);
    expect(queries.filter(s => s.startsWith('insert into clinical_core.schema_migrations'))).toHaveLength(4);
    expect(queries.some(s => s === 'set transaction isolation level repeatable read read only')).toBe(true);
    expect(await witness()).toEqual(before); expect(await projection()).toEqual(schema); await absent();
  }, 60000);
  it.each(['clinical_core', 'postgres', 'clinical_core_production'])('refuses database %s before fences or DDL', async name => {
    const queries: string[] = [];
    await expect(rehearseClinicPreservingTransition(database(async sql => { queries.push(sql); }, name), artifact, source))
      .rejects.toMatchObject({ category: 'boundary_refused', stage: 'database_identity' });
    expect(queries.some(s => /pg_try_advisory|^lock table|^(create|alter|insert|update|delete)/i.test(s))).toBe(false); await absent();
  });
  it.each([112, 113, 114, 115])('refuses altered source migration index %s without any transaction', async index => {
    const altered = structuredClone(artifact); altered.files[altered.manifest.migrations[index].file] += '\nselect 1;';
    let opened = false;
    await expect(rehearseClinicPreservingTransition({ transaction: async () => { opened = true; throw Error('unexpected'); } }, altered, source))
      .rejects.toMatchObject({ category: 'source_refused' });
    expect(opened).toBe(false);
  });
  it('refuses a claimed source approval before opening any transaction', async () => {
    let opened = false;
    await expect(rehearseClinicPreservingTransition({ transaction: async () => { opened = true; throw Error('unexpected'); } }, artifact, { ...source, upgradeAuthorized: true }))
      .rejects.toMatchObject({ category: 'source_refused' }); expect(opened).toBe(false);
  });
  it('does not claim rollback if the transaction adapter never executes the callback', async () => {
    await expect(rehearseClinicPreservingTransition({ transaction: async () => undefined as never }, artifact, source))
      .rejects.toMatchObject({ category: 'rollback_unconfirmed' }); await absent();
  });
  it.each(['record', 'receipt', 'schema'])('refuses %s changed while acquiring table locks before extension DDL', async change => {
    const queries: string[] = [];
    await expect(rehearseClinicPreservingTransition(database(async (sql, _args, tx) => {
      queries.push(sql);
      if (sql.startsWith('lock table')) await tx.query(change === 'record'
        ? "update clinical_core.organizations set organization_label='FICTIONAL changed'"
        : change === 'receipt' ? "update clinical_core.schema_migrations set applied_at=applied_at+interval '1 second'"
          : 'create function clinical_core.unreviewed_before_lock() returns int language sql as $$ select 1 $$');
    }), artifact, source)).rejects.toMatchObject({ category: 'admission_changed', stage: 'after_lock' });
    expect(queries.some(s => s.startsWith('insert into clinical_core.schema_migrations'))).toBe(false); await absent();
  }, 30000);
  it.each([113, 114, 115, 116])('detects same-count record corruption immediately after prefix %s and rolls back', async prefix => {
    let inserted = 0;
    await expect(rehearseClinicPreservingTransition(database(async (sql, _args, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations') && ++inserted === prefix - 112)
        await tx.query("update clinical_core.organizations set organization_label='FICTIONAL corrupted'");
    }), artifact, source)).rejects.toMatchObject({ category: 'preservation_refused', stage: 'preservation_' + prefix });
    expect(inserted).toBe(prefix - 112); await absent();
  }, 30000);
  it.each([113, 114, 115, 116])('rejects an unprescribed metadata change after prefix %s', async prefix => {
    let inserted = 0;
    await expect(rehearseClinicPreservingTransition(database(async (sql, _args, tx) => {
      if (sql.startsWith('insert into clinical_core.schema_migrations') && ++inserted === prefix - 112)
        await tx.query('create function clinical_core.unreviewed_during_upgrade() returns int language sql as $$ select 1 $$');
    }), artifact, source)).rejects.toMatchObject({ category: 'schema_delta_refused', stage: 'preservation_' + prefix });
    await absent();
  }, 30000);
  it('rolls back all schema work when a migration receipt fails', async () => {
    await expect(rehearseClinicPreservingTransition(database(async sql => {
      if (sql.startsWith('insert into clinical_core.schema_migrations')) throw Error('FICTIONAL receipt lost');
    }), artifact, source)).rejects.toMatchObject({ category: 'rehearsal_failed', stage: 'extension_113' }); await absent();
  });
  it('refuses a failed second transaction rather than inferring readback from the first', async () => {
    let calls = 0; const actual = database();
    const unavailable: ClinicalCoreDatabase = { transaction: work => { if (++calls === 2) throw Error('FICTIONAL readback unavailable'); return actual.transaction(work); } };
    await expect(rehearseClinicPreservingTransition(unavailable, artifact, source)).rejects.toMatchObject({ category: 'rollback_readback_refused' });
    expect(calls).toBe(2); await absent();
  }, 30000);
  it('detects new data between rollback and fresh readback instead of certifying the old snapshot', async () => {
    const actual = database(); let calls = 0;
    const changed: ClinicalCoreDatabase = { transaction: async work => {
      if (++calls === 2) await pg.query("update clinical_core.organizations set organization_label='FICTIONAL after rollback' where id=$1", [org]);
      return actual.transaction(work);
    } };
    try { await expect(rehearseClinicPreservingTransition(changed, artifact, source)).rejects.toMatchObject({ category: 'rollback_readback_refused' }); }
    finally { await pg.query("update clinical_core.organizations set organization_label='FICTIONAL rollback' where id=$1", [org]); }
    await absent();
  }, 30000);
  it('refuses missing advisory-lock acquisition before table locks or DDL', async () => {
    const queries: string[] = [];
    const refusing: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async (sql, args) => {
      queries.push(sql); if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: false }] } as never;
      return tx.query(sql, args);
    } })) };
    await expect(rehearseClinicPreservingTransition(refusing, artifact, source)).rejects.toMatchObject({ category: 'fence_busy' });
    expect(queries.some(s => /^lock table|^(create|alter|insert)/i.test(s))).toBe(false); await absent();
  });
  it('refuses an application-role read failure rather than rehearsing on hidden rows', async () => {
    const queries: string[] = [];
    const restricted: ClinicalCoreDatabase = { transaction: work => pg.transaction(async tx => {
      await tx.query('set local role clinical_core_api');
      return work({ query: async (sql, args = []) => {
        queries.push(sql);
        if (sql === 'select current_database() as name') return { rows: [{ name: 'clinical_core_qualification' }] } as never;
        return tx.query(sql, [...args]);
      } });
    }) };
    await expect(rehearseClinicPreservingTransition(restricted, artifact, source)).rejects.toMatchObject({ category: 'rehearsal_failed', stage: 'before_lock' });
    expect(queries.some(s => /^lock table|^(create|alter|insert)/i.test(s))).toBe(false); await absent();
  });
});
