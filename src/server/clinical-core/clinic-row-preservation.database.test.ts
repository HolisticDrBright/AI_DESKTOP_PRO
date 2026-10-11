import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { splitPostgresStatements } from './migrations';
import type { ClinicalCoreDatabase } from './database';
import { readClinicHistoricalRowWitness, assertClinicHistoricalRowsPreserved, assertClinicHistoricalRowsAtPrefixPreserved } from '../../../scripts/clinic-row-preservation.mjs';
import { projectTelehealthSchema } from '../../../scripts/telehealth-schema-projection.mjs';

// Actual embedded SQL and complete row reads, NOT the restricted native owner,
// a managed role, an admitted runtime schema or a deployable preserving operator.
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string> };
type Tx = { query: (sql: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
let pg: PGlite, artifact: Artifact, org: string;
const rollback = new Error('FICTIONAL intentional rollback');
const query = (sql: string, args: readonly unknown[] = []) => pg.query<{ name: string; digest: string }>(sql, [...args]);
const witness = () => pg.transaction(tx => readClinicHistoricalRowWitness(tx, artifact, source));
async function extend(tx: Tx) {
  for (const row of artifact.manifest.migrations.slice(112)) {
    for (const statement of splitPostgresStatements(artifact.files[row.file])) await tx.query(statement);
    await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
      [row.version, row.file.slice(15, -4), sha(artifact.files[row.file])]);
  }
}
async function rolled(work: (tx: Tx) => Promise<void>) {
  try { await pg.transaction(async tx => { await work(tx); throw rollback; }); }
  catch (error) { if (error !== rollback) throw error; }
}
beforeAll(async () => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
  expect(artifact.manifest.migrations).toHaveLength(116);
  pg = new PGlite({ extensions: { pgcrypto } });
  const database: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) })) };
  const migrations = artifact.manifest.migrations.map(r => ({ version: r.version, name: r.file.slice(15, -4), sql: artifact.files[r.file], sha256: sha(artifact.files[r.file]) }));
  await applyProductionClinicalCoreMigrations(database, migrations.slice(0, 106));
  for (const row of migrations.slice(106, 112)) {
    await pg.exec(row.sql);
    await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.name, row.sha256]);
  }
  org = randomUUID(); const person = randomUUID();
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL preservation')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_clinic_upgrade')", [person]);
  await pg.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)", [person]);
}, 120000);
afterAll(async () => { await pg?.close(); });

describe('complete historical row witness for the exact 112 to 116 source', () => {
  it('reads all 217 historical tables and all receipt columns, not counts alone', async () => {
    const before = await witness();
    expect(before).toMatchObject({ observedMigrationCount: 112, historicalTableCount: 217, historicalRowCount: 3,
      sourceOnly: true, schemaAdmissionProven: false, operatorAcceptance: false, custodyProven: false, managedRoleSemanticsVerified: false, phiAllowed: false });
    expect(Object.keys(before).some(k => /content|secret|payload/i.test(k))).toBe(false);
  });
  it('applies the actual four extensions, preserves rows and receipts, then physically rolls everything back', async () => {
    const before = await witness(); const schema = await projectTelehealthSchema(query);
    await rolled(async tx => {
      const fenced = await readClinicHistoricalRowWitness(tx, artifact, source);
      expect(fenced).toEqual(before);
      await extend(tx);
      const after = await readClinicHistoricalRowWitness(tx, artifact, source);
      expect(after).toMatchObject({ observedMigrationCount: 116, newRows: 0, historicalRowCount: 3 });
      expect(() => assertClinicHistoricalRowsPreserved(fenced, after)).not.toThrow();
    });
    expect(await witness()).toEqual(before);
    expect(await projectTelehealthSchema(query)).toEqual(schema);
    expect((await pg.query<{ absent: boolean }>("select to_regclass('clinical_core.clinic_record_requests') is null absent")).rows[0].absent).toBe(true);
  }, 60000);
  it.each([
    ['same-count record change', "update clinical_core.organizations set organization_label='FICTIONAL changed'"],
    ['receipt timestamp change', "update clinical_core.schema_migrations set applied_at=applied_at+interval '1 second'"],
    ['protected hold removal', 'delete from clinical_private.owned_legal_holds'],
  ])('refuses %s despite an otherwise exact source ledger', async (_name, sql) => {
    const before = await witness();
    await rolled(async tx => {
      await extend(tx); await tx.query(sql);
      const after = await readClinicHistoricalRowWitness(tx, artifact, source);
      expect(() => assertClinicHistoricalRowsPreserved(before, after)).toThrow('clinic_row_preservation_refused');
    });
    expect(await witness()).toEqual(before);
  }, 30000);
  it('refuses newly seeded admission keys, including fictional ones', async () => {
    await rolled(async tx => {
      await extend(tx);
      await tx.query("insert into clinical_private.telehealth_admission_keys(key_id,secret) values('fictional-source-test',decode(repeat('ab',32),'hex'))");
      await expect(readClinicHistoricalRowWitness(tx, artifact, source)).rejects.toThrow('clinic_row_preservation_refused');
    });
  }, 30000);
  it.each([
    "update clinical_core.schema_migrations set name='unknown_source' where version=(select min(version) from clinical_core.schema_migrations)",
    'create table clinical_private.unreviewed_extra(id int)',
  ])('refuses a same-count source ledger or table-inventory drift: %s', async sql => {
    await rolled(async tx => { await tx.query(sql); await expect(readClinicHistoricalRowWitness(tx, artifact, source)).rejects.toThrow('clinic_row_preservation_refused'); });
  });
  it('does not produce an RLS-filtered witness through the application role', async () => {
    await expect(pg.transaction(async tx => {
      await tx.query('set local role clinical_core_api');
      return readClinicHistoricalRowWitness(tx, artifact, source);
    })).rejects.toMatchObject({ code: '42501' });
    expect((await witness()).historicalRowCount).toBe(3);
  });
  it.each([113, 114, 115] as const)('preserves the actual prefix %s without relabeling it as a complete successor', async prefix => {
    const before = await witness();
    await rolled(async tx => {
      for (const row of artifact.manifest.migrations.slice(112, prefix)) {
        for (const statement of splitPostgresStatements(artifact.files[row.file])) await tx.query(statement);
        await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.file.slice(15, -4), sha(artifact.files[row.file])]);
      }
      const after = await readClinicHistoricalRowWitness(tx, artifact, source, prefix);
      expect(after.observedMigrationCount).toBe(prefix);
      expect(() => assertClinicHistoricalRowsAtPrefixPreserved(before, after, prefix)).not.toThrow();
      expect(() => assertClinicHistoricalRowsPreserved(before, after)).toThrow('clinic_row_preservation_refused');
      await expect(readClinicHistoricalRowWitness(tx, artifact, source)).rejects.toThrow('clinic_row_preservation_refused');
    });
    expect(await witness()).toEqual(before);
  }, 30000);
  it.each([111, 117, 113.5, '113'])('refuses invalid explicit prefix %s before any database query', async prefix => {
    let queries = 0;
    await expect(readClinicHistoricalRowWitness({ query: async () => { queries++; throw Error('unexpected'); } }, artifact, source, prefix as never))
      .rejects.toThrow('clinic_row_preservation_refused');
    expect(queries).toBe(0);
  });
  it.each(['rls_on', 'truncated_inventory', 'missing_table_digest', 'too_many_rows', 'unknown_digest_field', 'bad_receipt_digest', 'missing_receipt'])
    ('rejects incomplete or malformed database results: %s', async change => {
      await pg.transaction(async tx => {
        const refusing: Tx = { query: async (sql, args) => {
          const r = await tx.query<Record<string, unknown>>(sql, args);
          if (change === 'rls_on' && sql.includes("current_setting('row_security')")) r.rows[0].value = 'on';
          if (change === 'truncated_inventory' && sql.includes('c.relkind::text kind')) r.rows.pop();
          if (sql.includes('from (select encode(sha256')) {
            if (change === 'missing_table_digest') r.rows.pop();
            if (change === 'too_many_rows') r.rows[0].row_count = 100001;
            if (change === 'unknown_digest_field') r.rows[0].unreviewed = true;
          }
          if (sql.includes('jsonb_agg(to_jsonb(r)')) {
            if (change === 'bad_receipt_digest') r.rows[0].sha256 = 'not-a-digest';
            if (change === 'missing_receipt') r.rows[0].row_count = 111;
          }
          return r;
        } };
        await expect(readClinicHistoricalRowWitness(refusing, artifact, source)).rejects.toThrow('clinic_row_preservation_refused');
      });
    });
  it.each(['operatorAcceptance', 'schemaAdmissionProven', 'custodyProven', 'managedRoleSemanticsVerified', 'phiAllowed'])
    ('refuses a witness promoted into %s', async flag => {
      const before = await witness();
      await rolled(async tx => {
        await extend(tx); const after = await readClinicHistoricalRowWitness(tx, artifact, source);
        expect(() => assertClinicHistoricalRowsPreserved(before, { ...after, [flag]: true })).toThrow('clinic_row_preservation_refused');
      });
    }, 30000);
});
