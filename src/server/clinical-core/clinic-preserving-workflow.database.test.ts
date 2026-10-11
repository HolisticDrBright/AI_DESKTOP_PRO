import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { splitPostgresStatements } from './migrations';
import { rehearseClinicPreservingTransition } from './clinic-preserving-rollback';
import { executeClinicPreservingWorkflow, clinicWorkflowSha256, type ClinicWorkflowBinding,
  type ClinicWorkflowObservation, type ClinicWorkflowPorts, type ClinicWorkflowStage } from './clinic-preserving-workflow';
import { projectTelehealthSchema } from '../../../scripts/telehealth-schema-projection.mjs';
import { buildClinicPreservingTransition, CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';
import { readClinicHistoricalRowWitness, assertClinicHistoricalRowsAtPrefixPreserved } from '../../../scripts/clinic-row-preservation.mjs';

// Database-name responses alone are modeled for PGlite. All 116 source SQL,
// every row/receipt read, fences/table locks, rollback, commit and subsequent
// readbacks are actual embedded transactions. The custody port is in-memory;
// these tests do not prove native file durability, real lock interleaving,
// independently admitted managed definitions or AWS execution.
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string> };
let artifact: Artifact;
const databases: PGlite[] = [];
beforeAll(() => {
  artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
}, 60000);
afterAll(async () => { for (const db of databases) await db.close(); });
async function fixture() {
  const pg = new PGlite({ extensions: { pgcrypto } }); databases.push(pg);
  const actual: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) })) };
  const named: ClinicalCoreDatabase = { transaction: work => pg.transaction(tx => work({ query: (sql, args = []) => {
    if (sql === 'select current_database() as name') return Promise.resolve({ rows: [{ name: 'clinical_core_qualification' }] }) as never;
    return tx.query(sql, [...args]);
  } })) };
  const rows = artifact.manifest.migrations.map(r => ({ version: r.version, name: r.file.slice(15, -4), sql: artifact.files[r.file], sha256: sha(artifact.files[r.file]) }));
  await applyProductionClinicalCoreMigrations(actual, rows.slice(0, 106));
  for (const row of rows.slice(106, 112)) {
    await pg.exec(row.sql); await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.name, row.sha256]);
  }
  const org = randomUUID(), person = randomUUID();
  await pg.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL workflow')", [org]);
  await pg.query("insert into clinical_core.persons(id,subject_key) values($1,'subject_fictional_workflow')", [person]);
  await pg.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$1)", [person]);
  const binding: ClinicWorkflowBinding = { contract: 'clinic-preserving-workflow-binding/1', execution: 'injected_protocol_qualification',
    sourceCommit: 'a'.repeat(40), operatorSha256: 'b'.repeat(64), sourceArtifactSha256: clinicWorkflowSha256(artifact),
    independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256, targetSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64), phiAllowed: false, activation: 'blocked' };
  const observe = (): Promise<ClinicWorkflowObservation> => actual.transaction(async tx => {
    await tx.query('set transaction isolation level repeatable read read only');
    const witness = await readClinicHistoricalRowWitness(tx, artifact, source);
    const projection = await projectTelehealthSchema((sql, args) => tx.query<{ name: string; digest: string }>(sql, args));
    return { contract: 'clinic-preserving-workflow-observation/1', execution: 'injected_protocol_qualification',
      bindingSha256: clinicWorkflowSha256(binding), witness, schemaSha256: clinicWorkflowSha256(projection), phiAllowed: false, activation: 'blocked' };
  });
  const initial = await observe(), events: ClinicWorkflowStage[] = []; let admitted = false, forwards = 0, settlements = 0, lostReply = false;
  const verify = async () => {};
  const ports: ClinicWorkflowPorts = {
    guard: async incoming => { expect(incoming).toEqual(binding); }, withFence: work => work({ verify }), observe,
    rehearse: async () => { const r = await rehearseClinicPreservingTransition(named, artifact, source); expect(r.rolledBack).toBe(true); return observe(); },
    forward: async (_binding, baseline) => {
      forwards++;
      await actual.transaction(async tx => {
        await tx.query('set transaction isolation level read committed'); await tx.query('set local row_security=off');
        for (const name of ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures'])
          expect((await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) acquired', [name])).rows[0].acquired).toBe(true);
        const plan = buildClinicPreservingTransition(artifact, source);
        await tx.query('lock table ' + [...plan.preservation.historicalTableNames, plan.preservation.ledgerTable].sort()
          .map(name => name.split('.').map(part => '"' + part + '"').join('.')).join(',') + ' in share row exclusive mode');
        expect(await readClinicHistoricalRowWitness(tx, artifact, source, 112)).toEqual(baseline.witness);
        for (const transition of plan.transitions) {
          const row = artifact.manifest.migrations[transition.toCount - 1];
          for (const sql of splitPostgresStatements(artifact.files[row.file])) await tx.query(sql);
          await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.file.slice(15, -4), transition.sqlSha256]);
          const after = await readClinicHistoricalRowWitness(tx, artifact, source, transition.toCount as 113 | 114 | 115 | 116);
          assertClinicHistoricalRowsAtPrefixPreserved(baseline.witness, after, transition.toCount as 113 | 114 | 115 | 116);
        }
      });
      if (lostReply) throw Error('FICTIONAL response lost after actual commit');
      return observe();
    },
    createCustody: async () => ({ verify, record: async stage => { events.push(stage); if (stage === 'write_admitted') admitted = true; },
      finding: async () => {}, settle: async () => ({ runId: '5'.repeat(32), journalSha256: '6'.repeat(64), retire: async () => { settlements++; } }) }),
    openRecovery: async () => ({ baseline: structuredClone(initial), writeAdmitted: admitted, verify,
      settle: async () => ({ runId: '5'.repeat(32), journalSha256: '6'.repeat(64), retire: async () => { settlements++; } }) }),
  };
  return { pg, binding, ports, initial, observe, events, forwards: () => forwards, settlements: () => settlements,
    loseReply: () => { lostReply = true; } };
}
describe('actual embedded SQL behind the preserving command protocol', () => {
  it('rehearses physical rollback, commits exact source, and checks all historical records/receipts on both fresh readbacks', async () => {
    const h = await fixture();
    const result = await executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports);
    expect(h.events).toEqual(['rehearsal', 'write_admitted', 'write_reply', 'readback_one', 'readback_two']);
    expect(result.observation.witness).toMatchObject({ observedMigrationCount: 116, historicalRowCount: 3, historicalTableCount: 217,
      historicalDataSha256: h.initial.witness.historicalDataSha256, historicalReceiptsSha256: h.initial.witness.historicalReceiptsSha256, newRows: 0 });
    expect(await h.observe()).toEqual(result.observation); expect(h.forwards()).toBe(1); expect(h.settlements()).toBe(1);
    expect(result).toMatchObject({ custodyProven: false, canonicalSchemaAdmissionProven: false, operatorAcceptance: false, phiAllowed: false });
  }, 120000);
  it('retains uncertainty after an actual commit loses its response, then reconciles read-only without another write', async () => {
    const h = await fixture(); h.loseReply();
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'unknown' });
    expect(h.events).toEqual(['rehearsal', 'write_admitted']); expect(h.settlements()).toBe(0); expect(h.forwards()).toBe(1);
    const observed = await h.observe(); expect(observed.witness.observedMigrationCount).toBe(116);
    const result = await executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports);
    expect(result).toMatchObject({ command: 'reconcile', observedMigrationCount: 116, databaseMutationPerformed: false, writeOutcome: 'unknown', retryPerformed: false });
    expect(h.forwards()).toBe(1); expect(await h.observe()).toEqual(observed); expect(h.settlements()).toBe(1);
  }, 120000);
  it('an interrupted rehearsal leaves actual112 intact and recovery cannot admit an unrelated successor', async () => {
    const h = await fixture(), old = h.ports.rehearse;
    h.ports.rehearse = async (...args) => { await old(...args); throw Error('FICTIONAL rehearsal receipt lost'); };
    await expect(executeClinicPreservingWorkflow('upgrade', h.binding, artifact, source, h.ports)).rejects.toMatchObject({ writeOutcome: 'not_invoked' });
    expect(await h.observe()).toEqual(h.initial); expect(h.forwards()).toBe(0);
    const result = await executeClinicPreservingWorkflow('reconcile', h.binding, artifact, source, h.ports);
    expect(result.observedMigrationCount).toBe(112); expect(h.forwards()).toBe(0);
  }, 120000);
});
