import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations, type ClinicalCoreMigration } from './migrations';
import { applyGovernedCatalogMigrations, loadHistoricalGovernedCatalogMigrations as loadGovernedCatalogMigrations } from './catalog-migrations';
import { CARE_ERASURE_AWS as A, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';
import { loadCatalogForwardCandidate, runCatalogForwardUpgrade, catalogForwardObservationSha256, CATALOG_FORWARD_UPGRADE } from './catalog-forward-upgrade';
import { executeCatalogForwardApply, assertCatalogForwardApplyReadback } from './catalog-forward-apply-command';
import type { CatalogRollbackDependencies } from './catalog-forward-rehearsal-command';

let pg: PGlite, core: ClinicalCoreMigration[], reference: ClinicalCoreMigration[], candidate: ClinicalCoreMigration;
const build = { sourceCommit: 'a'.repeat(40), clean: true, lastingApplyAvailable: true };
const configuration: CareErasureUpgradeConfiguration = { account: A.account, region: A.region, clusterArn: A.clusterArn,
  secretArn: A.secretArn, databaseName: A.databaseName, phiAllowed: false, environment: 'synthetic-staging', dataClassification: 'synthetic_only' };
type Inner = { query: (sql: string, args?: unknown[]) => Promise<unknown> };
function database(intercept?: (sql: string, tx: Inner) => Promise<void>): ClinicalCoreDatabase {
  return { transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name: 'clinical_core' }] };
    return tx.query(sql, [...args]);
  } } as ClinicalCoreTransaction)) };
}
function dependencies(events: string[] = []): CatalogRollbackDependencies {
  return { verifyCustody: () => {}, record: (stage, digest) => { expect(digest).toMatch(/^[a-f0-9]{64}$/); events.push(stage); },
    observeCaller: () => ({ Account: A.account, Arn: `arn:aws:sts::${A.account}:assumed-role/FictionalOperator/session` }),
    observeFoundation: () => ({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
      StackId: `arn:aws:cloudformation:${A.region}:${A.account}:stack/${A.foundation}/fictional`, Outputs: Object.entries({
        PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: A.databaseName,
        ClinicalApiId: A.apiId, DatabaseClusterArn: A.clusterArn, DatabaseSecretArn: A.secretArn,
      }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }),
    loadCore: () => core, loadReference: () => reference, loadCandidate: () => candidate, createDatabase: () => database() };
}
const inspect = () => runCatalogForwardUpgrade(database(), core, reference, candidate, configuration, 'inspect');
beforeAll(async () => {
  pg = new PGlite({ extensions: { pgcrypto } }); core = loadClinicalCoreMigrations(); reference = loadGovernedCatalogMigrations(); candidate = loadCatalogForwardCandidate();
  await applyClinicalCoreMigrations(database(), core); const alias = core.find(m => m.version === '20260821049700')!;
  await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', ['20260902230000', alias.name, alias.sha256]);
  await applyGovernedCatalogMigrations(database(), reference);
  await pg.exec("insert into clinical_reference.knowledge_sources(stable_id,environment) values('src_fictional_apply_held','synthetic-staging')");
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('custodied preserving apply — actual local SQL, not AWS acceptance', () => {
  it('refuses dirty source and foreign caller before the database factory', async () => {
    let opened = 0; const d = { ...dependencies(), createDatabase: () => { opened++; return database(); } };
    await expect(executeCatalogForwardApply({ ...build, clean: false }, d)).rejects.toThrow('boundary_refused');
    await expect(executeCatalogForwardApply(build, { ...d, observeCaller: () => ({ Account: '173535830222', Arn: 'arn:aws:iam::173535830222:root' }) })).rejects.toThrow('boundary_refused');
    expect(opened).toBe(0); expect((await inspect()).referenceMigrationCount).toBe(2);
  });
  it('records admission before writer SQL and refuses lost custody without a lasting change', async () => {
    const before = await inspect(), events: string[] = []; let valid = true, writes = 0;
    const d = { ...dependencies(events), verifyCustody: () => { if (!valid) throw Error('fictional custody lost'); },
      createDatabase: () => database(async sql => { if (sql.startsWith('insert into clinical_reference.schema_migrations')) { writes++; valid = false; } }) };
    await expect(executeCatalogForwardApply(build, d)).rejects.toThrow('upgrade_failed');
    expect(writes).toBe(1); expect(events).toEqual(['catalog_apply_admitted']); expect((await inspect()).observationSha256).toBe(before.observationSha256);
  });
  it('captures caller artifacts before inspection can await', async () => {
    const suppliedCore = core.map(m => ({ ...m })), suppliedCandidate = { ...candidate }, events: string[] = [];
    let altered = false;
    const d = { ...dependencies(events), loadCore: () => suppliedCore, loadCandidate: () => suppliedCandidate,
      createDatabase: () => database(async sql => {
        if (!altered) { altered = true; suppliedCore[0].sql += '\nselect 12345;'; suppliedCandidate.sql += '\nselect 12345;'; }
        // A forced rollback keeps this input-capture test on the predecessor.
        if (sql.startsWith('insert into clinical_reference.schema_migrations')) throw Error('fictional forced rollback');
      }) };
    await expect(executeCatalogForwardApply(build, d)).rejects.toMatchObject({ category: 'upgrade_failed', stage: 'ledger_receipt' });
    expect(events).toEqual(['catalog_apply_admitted']); expect((await inspect()).referenceMigrationCount).toBe(2);
  });
  it('requires independent database readback even if the writer claims a perfect committed result', async () => {
    const events: string[] = []; let inspections = 0;
    const d = { ...dependencies(events), run: async (...args: Parameters<typeof runCatalogForwardUpgrade>) => {
      if (args[5] === 'inspect') { inspections++; return runCatalogForwardUpgrade(...args); }
      const before = await inspect();
      return { ...before, command: 'upgrade' as const, applied: true, referenceMigrationCount: 3 as const,
        referenceLedgerSha256: CATALOG_FORWARD_UPGRADE.referenceAfterSha256,
        observationSha256: catalogForwardObservationSha256(configuration, before.dataSha256, before.preservedSchemaSha256, true) };
    } };
    await expect(executeCatalogForwardApply(build, d)).rejects.toMatchObject({ category: 'verification_failed', stage: 'apply_readback' });
    expect(inspections).toBe(2); expect(events).toEqual(['catalog_apply_admitted', 'catalog_apply_committed']); expect((await inspect()).referenceMigrationCount).toBe(2);
  });
  it('applies exactly once, independently reads back and preserves a held record and complete historical data', async () => {
    const events: string[] = []; let transactions = 0;
    const d = { ...dependencies(events), createDatabase: () => ({ transaction: work => { transactions++; return database().transaction(work); } } satisfies ClinicalCoreDatabase) };
    const before = await inspect(), result = await executeCatalogForwardApply(build, d);
    expect(result).toMatchObject({ applied: true, alreadyApplied: false, independentReadbackVerified: true, lastingApplyPerformed: true,
      before: { referenceMigrationCount: 2 }, after: { referenceMigrationCount: 3, dataSha256: before.dataSha256,
        preservedSchemaSha256: before.preservedSchemaSha256, rowCount: before.rowCount }, canonicalRegistered: false, hostedAcceptance: false, phiAllowed: false });
    expect(events).toEqual(['catalog_apply_admitted', 'catalog_apply_committed', 'catalog_apply_readback_verified']); expect(transactions).toBe(3);
    expect((await pg.query("select review_status,active_version from clinical_reference.knowledge_sources where stable_id='src_fictional_apply_held'")).rows)
      .toEqual([{ review_status: 'needs_review', active_version: null }]);
    assertCatalogForwardApplyReadback(result.before, result.after);
    for (const patch of [{ dataSha256: 'f'.repeat(64) }, { rowCount: result.after.rowCount + 1 }, { preservedSchemaSha256: 'f'.repeat(64) },
      { coreLedgerSha256: 'f'.repeat(64) }, { referenceLedgerSha256: before.referenceLedgerSha256 }, { tableCount: 88 },
      { phiAllowed: true }, { canonicalRegistered: true }, { hostedAcceptance: true }, { activationApproved: true },
      { dataPreserved: false }, { alreadyApplied: false }, { operatorSource: { ...build, sourceCommit: 'b'.repeat(40) } }])
      expect(() => assertCatalogForwardApplyReadback(result.before, { ...result.after, ...patch } as typeof result.after)).toThrow('verification_failed');
    for (const patch of [{ referenceMigrationCount: 4 }, { dataPreserved: false }, { phiAllowed: true }, { observationSha256: 'f'.repeat(64) }])
      expect(() => assertCatalogForwardApplyReadback({ ...result.before, ...patch } as typeof result.before, result.after)).toThrow('verification_failed');
    const replay = await executeCatalogForwardApply(build, dependencies());
    expect(replay).toMatchObject({ applied: false, alreadyApplied: true, lastingApplyPerformed: false, independentReadbackVerified: true });
    expect(replay.before).toEqual(replay.after); expect(loadGovernedCatalogMigrations()).toHaveLength(2);
  });
});
