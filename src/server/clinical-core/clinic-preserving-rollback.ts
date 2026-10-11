if (typeof window !== 'undefined') throw Error('clinic-preserving-rollback is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { splitPostgresStatements } from './migrations';
import { buildClinicPreservingTransition } from '../../../scripts/clinic-preserving-transition.mjs';
import { readClinicHistoricalRowWitness, assertClinicHistoricalRowsAtPrefixPreserved, type ClinicRowWitness } from '../../../scripts/clinic-row-preservation.mjs';
import { projectTelehealthSchema } from '../../../scripts/telehealth-schema-projection.mjs';

type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string> };
type Projection = { name: string; digest: string }[];
type Prefix = 112 | 113 | 114 | 115 | 116;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const locks = ['ai-desktop-pro:production-clinical-core-migrations', 'ai-desktop-pro:qualification-fixtures'];
const qualified = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}\.[a-z][a-z0-9_]{0,62}$/.test(name)) throw new ClinicPreservingRollbackError('source_refused');
  return name.split('.').map(s => '"' + s + '"').join('.');
};
export class ClinicPreservingRollbackError extends Error {
  constructor(readonly category: 'source_refused' | 'boundary_refused' | 'fence_busy' | 'admission_changed' | 'schema_delta_refused'
    | 'preservation_refused' | 'rollback_unconfirmed' | 'rollback_readback_refused' | 'rehearsal_failed', readonly stage?: string) {
    super(category); this.name = 'ClinicPreservingRollbackError';
  }
}
type Observed = { witness: ClinicRowWitness; projection: Projection };
export type ClinicPreservingRollbackResult = {
  contract: 'clinic-preserving-rollback/1'; execution: 'source_rollback_only'; observedDatabaseName: 'clinical_core_qualification';
  beforeMigrationCount: 112; rehearsedMigrationCount: 116; observedAfterRollbackCount: 112; checkedTransitions: 4;
  historicalTableCount: 217; historicalRowCount: number; historicalDataSha256: string; historicalReceiptsSha256: string;
  observedParentSchemaSha256: string; rolledBack: true; ddlCommitted: false;
  canonicalSchemaAdmissionProven: false; managedRoleSemanticsVerified: false; custodyProven: false; operatorAcceptance: false;
  phiAllowed: false; activation: 'blocked';
};
class Rollback extends Error {
  constructor(readonly before: Observed) { super('clinic_preserving_deliberate_rollback'); }
}
async function boundary(tx: ClinicalCoreTransaction) {
  const rows = (await tx.query<{ name: string }>('select current_database() as name')).rows;
  if (rows.length !== 1 || Object.keys(rows[0]).join(',') !== 'name' || rows[0].name !== 'clinical_core_qualification')
    throw new ClinicPreservingRollbackError('boundary_refused');
}
async function observe(tx: ClinicalCoreTransaction, artifact: Artifact, receipt: unknown, prefix: Prefix): Promise<Observed> {
  const witness = await readClinicHistoricalRowWitness(tx, artifact, receipt, prefix);
  const projection = await projectTelehealthSchema((sql, args) => tx.query<{ name: string; digest: string }>(sql, args));
  return { witness, projection };
}
function same(before: Observed, after: Observed) { return JSON.stringify(before) === JSON.stringify(after); }
/** Rollback-only transaction kernel. There is intentionally no commit mode,
 * CLI, cloud transport, runtime authority or admission claim. The source delta
 * checks prove unchanged observations outside the prescribed names, not that
 * the baseline or permitted changed definitions are canonical. The eventual
 * preserving operator MUST add independently compiled managed-schema admission
 * and durable commit custody before it can use a separate forward write path. */
export async function rehearseClinicPreservingTransition(database: ClinicalCoreDatabase, supplied: unknown,
  sourceReceipt: unknown): Promise<ClinicPreservingRollbackResult> {
  let artifact: Artifact, receipt: unknown;
  try {
    artifact = structuredClone(supplied) as Artifact; receipt = structuredClone(sourceReceipt);
    buildClinicPreservingTransition(artifact, receipt);
  } catch { throw new ClinicPreservingRollbackError('source_refused'); }
  const plan = buildClinicPreservingTransition(artifact, receipt);
  let stage = 'transaction_start';
  try {
    await database.transaction(async tx => {
      await tx.query('set transaction isolation level read committed');
      await tx.query("set local lock_timeout='5s'"); await tx.query("set local statement_timeout='30s'");
      await tx.query('set local row_security=off');
      stage = 'database_identity'; await boundary(tx);
      stage = 'fence';
      for (const key of locks) {
        const rows = (await tx.query<{ acquired: boolean }>('select pg_try_advisory_xact_lock(hashtext($1)) as acquired', [key])).rows;
        if (rows.length !== 1 || Object.keys(rows[0]).join(',') !== 'acquired' || rows[0].acquired !== true)
          throw new ClinicPreservingRollbackError('fence_busy');
      }
      stage = 'before_lock'; const initial = await observe(tx, artifact, receipt, 112);
      const names = [...plan.preservation.historicalTableNames, plan.preservation.ledgerTable].sort();
      await tx.query('lock table ' + names.map(qualified).join(',') + ' in share row exclusive mode');
      stage = 'after_lock'; const before = await observe(tx, artifact, receipt, 112);
      if (!same(initial, before)) throw new ClinicPreservingRollbackError('admission_changed');
      let previous = before;
      for (const transition of plan.transitions) {
        stage = 'extension_' + transition.toCount;
        const row = artifact.manifest.migrations[transition.toCount - 1];
        for (const statement of splitPostgresStatements(artifact.files[row.file])) await tx.query(statement);
        await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
          [row.version, row.file.slice(15, -4), transition.sqlSha256]);
        const after = await observe(tx, artifact, receipt, transition.toCount as Prefix);
        stage = 'preservation_' + transition.toCount;
        assertClinicHistoricalRowsAtPrefixPreserved(before.witness, after.witness, transition.toCount as 113 | 114 | 115 | 116);
        const old = new Map(previous.projection.map(r => [r.name, r.digest]));
        const next = new Map(after.projection.map(r => [r.name, r.digest]));
        const added = after.projection.filter(r => !old.has(r.name)).map(r => r.name);
        const changed = after.projection.filter(r => old.has(r.name) && old.get(r.name) !== r.digest).map(r => r.name);
        if (previous.projection.some(r => !next.has(r.name))
          || JSON.stringify(added) !== JSON.stringify(transition.addedObjects.map(r => r.name))
          || JSON.stringify(changed) !== JSON.stringify(transition.changedObjects.map(r => r.name)))
          throw new ClinicPreservingRollbackError('schema_delta_refused');
        previous = after;
      }
      throw new Rollback(before);
    });
    // A transaction adapter that swallowed the sentinel cannot certify rollback.
    throw new ClinicPreservingRollbackError('rollback_unconfirmed');
  } catch (error) {
    if (error instanceof Rollback) {
      stage = 'rollback_readback';
      let after: Observed;
      try { after = await database.transaction(async tx => {
        await tx.query('set transaction isolation level repeatable read read only');
        await tx.query("set local statement_timeout='30s'"); await boundary(tx);
        return observe(tx, artifact, receipt, 112);
      }); } catch { throw new ClinicPreservingRollbackError('rollback_readback_refused', stage); }
      if (!same(error.before, after)) throw new ClinicPreservingRollbackError('rollback_readback_refused', stage);
      return { contract: 'clinic-preserving-rollback/1', execution: 'source_rollback_only', observedDatabaseName: 'clinical_core_qualification',
        beforeMigrationCount: 112, rehearsedMigrationCount: 116, observedAfterRollbackCount: 112, checkedTransitions: 4,
        historicalTableCount: 217, historicalRowCount: after.witness.historicalRowCount,
        historicalDataSha256: after.witness.historicalDataSha256, historicalReceiptsSha256: after.witness.historicalReceiptsSha256,
        observedParentSchemaSha256: sha(JSON.stringify(after.projection)), rolledBack: true, ddlCommitted: false,
        canonicalSchemaAdmissionProven: false, managedRoleSemanticsVerified: false, custodyProven: false,
        operatorAcceptance: false, phiAllowed: false, activation: 'blocked' };
    }
    if (error instanceof ClinicPreservingRollbackError) throw new ClinicPreservingRollbackError(error.category, error.stage ?? stage);
    if (error instanceof Error && error.message === 'clinic_row_preservation_refused')
      throw new ClinicPreservingRollbackError('preservation_refused', stage);
    throw new ClinicPreservingRollbackError('rehearsal_failed', stage);
  }
}
