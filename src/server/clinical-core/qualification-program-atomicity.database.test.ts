import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { runQualificationProgramSchemaUpgrade } from './qualification-program-schema-upgrade';

const files = [
  'infra/aws-clinical-core/production-candidates/lab-result-transfer-v2.sql',
  'infra/aws-clinical-core/production-candidates/lab-observation-attestation.sql',
  'infra/aws-clinical-core/production-candidates/production-program-assignments.sql',
  'infra/aws-clinical-core/production-candidates/production-program-consumer-boundary.sql',
  'infra/aws-clinical-core/source-candidates/qualification-program-boundary.sql',
] as const;
const lf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** This is a local transaction rehearsal. It does not authorize or perform an AWS upgrade. */
describe('five blocked program candidates are one atomic qualification change', () => {
  it('rolls back an interruption after each file and commits all five closed by default', async () => {
    const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));
    expect(artifact.candidate).toMatchObject({
      migrationCount: 112,
      migrationReleaseSha256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
    });
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      const migrations = artifact.manifest.migrations.map((entry: { version: string; file: string }) => ({
        version: entry.version, name: entry.file.slice(15, -4), sql: artifact.files[entry.file], sha256: sha(artifact.files[entry.file]),
      }));
      const admin: ClinicalCoreDatabase = {
        transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => {
          // PGlite's sole database is named postgres. Only the operator's fixed
          // identity observation is projected to the fictional qualification name;
          // every DDL, lock, custody read and transaction still runs on PGlite.
          if (sql === 'select current_database() name') return Promise.resolve({ rows: [{ name: 'clinical_core_qualification' }], rowCount: 1 }) as never;
          return tx.query(sql, [...parameters]) as never;
        } })),
      };
      await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
      for (const entry of migrations.slice(106)) {
        await db.exec(entry.sql);
        await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
          [entry.version, entry.name, entry.sha256]);
      }
      const person = randomUUID(), clinic = randomUUID();
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL ATOMICITY CLINIC')", [clinic]);

      async function snapshot() {
        const ledger = await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version');
        const people = await db.query('select id,subject_key from clinical_core.persons order by id');
        const clinics = await db.query('select id,organization_label from clinical_core.organizations order by id');
        const relations = await db.query(`select n.nspname,c.relname,c.relkind::text kind from pg_class c
          join pg_namespace n on n.oid=c.relnamespace where n.nspname in
          ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference','fullscript_delivery')
          order by n.nspname,c.relname,c.relkind`);
        const functions = await db.query(`select n.nspname,p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in
          ('clinical_core','clinical_private','clinical_audit','clinical_reference','commercial_reference','fullscript_delivery')
          and p.prokind='f' order by n.nspname,p.oid::regprocedure::text`);
        return JSON.stringify({ ledger: ledger.rows, people: people.rows, clinics: clinics.rows,
          relations: relations.rows, functions: functions.rows });
      }
      const before = await snapshot();
      expect(JSON.parse(before).ledger).toHaveLength(112);
      for (let stage = 1; stage <= files.length; stage++) {
        await expect(db.transaction(async tx => {
          for (const path of files.slice(0, stage)) await tx.exec(lf(path));
          throw new Error(`fictional_interruption_after_${stage}`);
        })).rejects.toThrow(`fictional_interruption_after_${stage}`);
        expect(await snapshot(), `schema or data changed after interrupted stage ${stage}`).toBe(before);
      }
      const inspected = await runQualificationProgramSchemaUpgrade(admin, 'inspect');
      expect(inspected).toMatchObject({ migrationCount: 112, boundaryPresent: false, applied: false });
      const rehearsal = await runQualificationProgramSchemaUpgrade(admin, 'rehearse');
      expect(rehearsal).toMatchObject({ boundaryPresent: false, applied: false, rolledBack: true });
      expect(await snapshot()).toBe(before);
      const upgrade = await runQualificationProgramSchemaUpgrade(admin, 'upgrade');
      expect(upgrade).toMatchObject({ boundaryPresent: true, applied: true, rolledBack: false });
      const after = await db.query('select version,name,sha256 from clinical_core.schema_migrations order by version');
      expect(after.rows).toEqual(JSON.parse(before).ledger);
      const boundary = await db.query<{ enabled: boolean }>('select enabled from clinical_core.program_qualification_boundary');
      expect(boundary.rows).toEqual([{ enabled: false }]);
      expect((await db.query('select identity_subject from clinical_core.program_qualification_subjects')).rows).toEqual([]);
      for (const table of ['production_program_activation', 'program_consumer_boundary_activation']) {
        expect((await db.query<{ enabled: boolean }>(`select enabled from clinical_core.${table}`)).rows)
          .toEqual([{ enabled: false }]);
      }
      expect((await db.query('select id,subject_key from clinical_core.persons where id=$1', [person])).rows).toHaveLength(1);
      expect((await db.query('select id from clinical_core.organizations where id=$1', [clinic])).rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 240_000);
});
