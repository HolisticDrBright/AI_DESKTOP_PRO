import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { applyClinicalCoreMigrations, loadClinicalCoreMigrations, type ClinicalCoreMigration } from './migrations';
import { applyGovernedCatalogMigrations, loadHistoricalGovernedCatalogMigrations as loadGovernedCatalogMigrations } from './catalog-migrations';
import { CARE_ERASURE_AWS, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { CATALOG_FORWARD_UPGRADE, catalogForwardMapping, loadCatalogForwardCandidate, runCatalogForwardUpgrade } from './catalog-forward-upgrade';
import { catalogSha256, importGovernedCatalog, manifestContentForHash, offerContentForHash,
  productContentForHash, type GovernedCatalogSeedManifest } from './aws-governed-catalog';
import { approveGovernedCatalogRelease, reviewGovernedCatalogVersion } from './aws-governed-catalog-review';
import { executeCatalogForwardInspectionCommand } from './catalog-forward-inspection-command';
import { executeCatalogForwardRollback } from './catalog-forward-rehearsal-command';
import { BeginTransactionCommand, ExecuteStatementCommand, CommitTransactionCommand, RollbackTransactionCommand, type Field } from '@aws-sdk/client-rds-data';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const configuration: CareErasureUpgradeConfiguration = { account: CARE_ERASURE_AWS.account, region: CARE_ERASURE_AWS.region,
  clusterArn: CARE_ERASURE_AWS.clusterArn, secretArn: CARE_ERASURE_AWS.secretArn, databaseName: CARE_ERASURE_AWS.databaseName,
  phiAllowed: false, environment: 'synthetic-staging', dataClassification: 'synthetic_only' };
let pg: PGlite, core: ClinicalCoreMigration[], reference: ClinicalCoreMigration[], candidate: ClinicalCoreMigration;
const organization = randomUUID(), reviewer = randomUUID();
type Inner = { query: (sql: string, args?: unknown[]) => Promise<unknown> };
type Intercept = (sql: string, transaction: Inner) => Promise<void>;
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
const database = (intercept?: Intercept, name = 'clinical_core'): ClinicalCoreDatabase => ({
  transaction: work => pg.transaction(async tx => work({ query: async (sql: string, args: readonly unknown[] = []) => {
    if (intercept) await intercept(sql, tx);
    if (sql === 'select current_database() as name') return { rows: [{ name }] };
    return tx.query(sql, args.map(unwrap));
  } } as ClinicalCoreTransaction)),
});
const inspect = (db = database()) => runCatalogForwardUpgrade(db, core, reference, candidate, configuration, 'inspect');
const invoke = async (command: 'upgrade' | 'rehearse', db = database()) => {
  const before = await inspect();
  return runCatalogForwardUpgrade(db, core, reference, candidate, configuration, command, before.observationSha256);
};
const atReceipt = (change: (tx: Inner) => Promise<void>) => database(async (sql, tx) => {
  if (sql.startsWith('insert into clinical_reference.schema_migrations')) await change(tx);
});
const predecessor = async () => expect((await pg.query('select version from clinical_reference.schema_migrations order by version')).rows).toHaveLength(2);
const rawOffers = async () => pg.transaction(async tx => {
  await tx.exec("set local role clinical_core_api; select set_config('clinical.catalog.environment','synthetic-staging',true)");
  return (await tx.query<{ offer_stable_id: string }>('select offer_stable_id from commercial_reference.affiliate_offer_versions')).rows;
});
function release(key: string, version: number, restricted = false): GovernedCatalogSeedManifest {
  const productBase = { stableId: `prd_forward_${key}`, version, displayName: 'Fictional upgrade product', productType: 'supplement' as const,
    accessTier: restricted ? 'practitioner_gated' as const : 'open' as const, declaredRestricted: restricted, directOrderAllowed: !restricted,
    clinicalPayload: { ingredients: ['Fictional ingredient'] }, sourceRefs: ['synthetic:catalog-forward-upgrade'] };
  const product = { ...productBase, contentSha256: catalogSha256(productContentForHash(productBase)) };
  const offerBase = { stableId: `off_forward_${key}`, version: 1, productStableId: product.stableId,
    destinationUrl: `https://example.invalid/${key}?ref=fictional`, trackingMetadata: { approval: 'catalog_owner_commercial_activation', approvalVersion: '1.0.0' },
    declaredRestricted: false, directOrderAllowed: true };
  const base = { contractVersion: 'governed-catalog-seed/1' as const, sourcePackageId: `synthetic.forward.${key}`,
    sourcePackageVersion: version, targetEnvironment: 'synthetic-staging' as const, dataClassification: 'reference_only' as const,
    containsPhi: false as const, products: [product], productLabels: [],
    commercialOffers: version === 1 ? [{ ...offerBase, contentSha256: catalogSha256(offerContentForHash(offerBase)) }] : [],
    protocolTemplates: [], safetyRules: [], knowledgeSources: [] };
  return { ...base, manifestSha256: catalogSha256(manifestContentForHash(base)) };
}
async function approve(manifest: GovernedCatalogSeedManifest) {
  await importGovernedCatalog(database(), manifest);
  await approveGovernedCatalogRelease(database(), { manifest, reviewerPersonId: reviewer,
    reason: 'Fictional preserving upgrade test only.', environment: 'synthetic-staging' });
}
beforeAll(async () => {
  core = loadClinicalCoreMigrations(); reference = loadGovernedCatalogMigrations(); candidate = loadCatalogForwardCandidate();
  pg = new PGlite({ extensions: { pgcrypto } });
  await applyClinicalCoreMigrations(database(), core);
  const alias = core.find(m => m.version === '20260821049700')!;
  await pg.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', ['20260902230000', alias.name, alias.sha256]);
  await applyGovernedCatalogMigrations(database(), reference);
  await pg.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'FICTIONAL catalog forward upgrade')", [organization]);
  await pg.query("insert into clinical_core.persons(id,synthetic_subject_key) values($1,'syn_catalog_forward_upgrade')", [reviewer]);
  await pg.query(`insert into clinical_reference.knowledge_sources(stable_id,environment)
    select 'src_fictional_upgrade_'||n,'synthetic-staging' from generate_series(1,6001) n`);
  for (const key of ['eligible', 'restricted']) {
    const manifest = release(key, 1); await approve(manifest);
    await reviewGovernedCatalogVersion(database(), { subjectType: 'affiliate_offer_version', stableId: manifest.commercialOffers[0]!.stableId,
      version: 1, reviewerPersonId: reviewer, outcome: 'approved', reason: 'Fictional destination review.', environment: 'synthetic-staging' });
  }
  await approve(release('restricted', 2, true));
}, 60000);
afterAll(async () => { await pg?.close(); });

describe('preserving reference forward upgrade — real local SQL, no hosted or activation claim', () => {
  it('pins core, historical alias, old reference and forward SQL separately', () => {
    const mapping = catalogForwardMapping(core, reference, candidate, configuration);
    expect(mapping.liveCore).toHaveLength(48); expect(mapping.before).toHaveLength(2); expect(mapping.after).toHaveLength(3);
    expect(mapping.candidateSqlSha256).toBe(CATALOG_FORWARD_UPGRADE.sqlSha256);
    expect(mapping.after.slice(0, 2)).toEqual(mapping.before); expect(loadGovernedCatalogMigrations()).toHaveLength(2);
  });
  it('refuses foreign target, PHI and altered artifacts before opening a transaction', async () => {
    let opened = false; const never: ClinicalCoreDatabase = { transaction: async () => { opened = true; throw Error('must not open'); } };
    for (const patch of [{ account: '173535830222' }, { region: 'us-west-2' }, { databaseName: 'clinical_core_qualification' },
      { clusterArn: CARE_ERASURE_AWS.clusterArn + '-other' }, { secretArn: CARE_ERASURE_AWS.secretArn + '-other' },
      { phiAllowed: true }, { environment: 'production-clinical' }, { dataClassification: 'phi' }])
      await expect(runCatalogForwardUpgrade(never, core, reference, candidate, { ...configuration, ...patch } as CareErasureUpgradeConfiguration, 'inspect')).rejects.toThrow('boundary_refused');
    for (const changed of [core.slice(0, -1), [...core, core[0]], [...core].reverse(),
      core.map((m, i) => i === 0 ? { ...m, sql: m.sql + '\nselect 1;', sha256: sha(m.sql + '\nselect 1;') } : m)])
      await expect(runCatalogForwardUpgrade(never, changed, reference, candidate, configuration, 'inspect')).rejects.toThrow('artifact_refused');
    for (const patch of [{ sql: candidate.sql + '\nselect 1;', sha256: sha(candidate.sql + '\nselect 1;') },
      { sql: candidate.sql.replace(/\n/g, '\r\n') }, { version: '20261008060001' }, { name: 'different_policy' }])
      await expect(runCatalogForwardUpgrade(never, core, reference, { ...candidate, ...patch }, configuration, 'inspect')).rejects.toThrow('artifact_refused');
    await expect(runCatalogForwardUpgrade(never, core, reference.slice(0, 1), candidate, configuration, 'inspect')).rejects.toThrow('artifact_refused');
    expect(opened).toBe(false);
  });
  it('inspects read-only, includes held rows and prints no contents or credentials', async () => {
    const queries: string[] = [];
    const result = await inspect(database(async sql => { queries.push(sql); }));
    expect(result).toMatchObject({ referenceMigrationCount: 2, tableCount: 89, applied: false, rolledBack: false,
      dataPreserved: true, schemaPreserved: true, canonicalRegistered: false, hostedAcceptance: false, activationApproved: false, phiAllowed: false });
    expect(result.rowCount).toBeGreaterThan(6000); expect(queries[0]).toContain('read only');
    expect(queries.some(sql => /^(create|alter|drop|insert|update|delete|lock)/i.test(sql))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/fictional_upgrade_|synthetic_label|secretArn|example\.invalid/); await predecessor();
  });
  it('requires a fresh inspection witness and refuses the actual wrong database name', async () => {
    await expect(runCatalogForwardUpgrade(database(), core, reference, candidate, configuration, 'upgrade')).rejects.toThrow('boundary_refused');
    await expect(runCatalogForwardUpgrade(database(), core, reference, candidate, configuration, 'upgrade', 'f'.repeat(64))).rejects.toThrow('observation_changed');
    for (const name of ['clinical_core_qualification', 'clinical_core_production']) await expect(inspect(database(undefined, name))).rejects.toThrow('boundary_refused');
    const before = await inspect();
    await pg.query("update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_upgrade_6001'");
    try { await expect(runCatalogForwardUpgrade(database(), core, reference, candidate, configuration, 'upgrade', before.observationSha256)).rejects.toThrow('observation_changed'); }
    finally { await pg.query("update clinical_reference.knowledge_sources set review_status='needs_review' where stable_id='src_fictional_upgrade_6001'"); }
    await predecessor();
  });
  it('refreshes the write snapshot after every writer lock and refuses an intervening row change', async () => {
    // PGlite is not a two-session Aurora race test. Assert the actual command
    // order/isolation contract and inject a real row change at lock admission.
    for (const command of ['upgrade', 'rehearse'] as const) {
      const before = await inspect(), queries: string[] = [];
      const changed = database(async (sql, tx) => {
        queries.push(sql);
        if (sql.startsWith('lock table ')) await tx.query("update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_upgrade_6001'");
      });
      await expect(runCatalogForwardUpgrade(changed, core, reference, candidate, configuration, command, before.observationSha256))
        .rejects.toThrow('observation_changed');
      expect(queries[0]).toBe('set transaction isolation level read committed');
      const locked = queries.findIndex(sql => sql.startsWith('lock table '));
      expect(locked).toBeGreaterThan(0);
      expect(queries.findIndex(sql => sql.startsWith('select version,name,sha256 from clinical_core.schema_migrations'))).toBeGreaterThan(locked);
      expect(queries.some(sql => sql.startsWith('drop policy') || sql.startsWith('insert into clinical_reference.schema_migrations'))).toBe(false);
      await predecessor();
      expect((await pg.query<{ review_status: string }>("select review_status from clinical_reference.knowledge_sources where stable_id='src_fictional_upgrade_6001'")).rows[0]?.review_status).toBe('needs_review');
    }
  });
  it('runs actual successor SQL in a rollback rehearsal and independently reads the predecessor', async () => {
    const before = await inspect();
    expect((await rawOffers()).map(row => row.offer_stable_id)).toContain('off_forward_restricted');
    expect(await invoke('rehearse')).toMatchObject({ command: 'rehearse', rolledBack: true, applied: false, referenceMigrationCount: 2,
      observationSha256: before.observationSha256, dataSha256: before.dataSha256 });
    expect((await rawOffers()).map(row => row.offer_stable_id)).toContain('off_forward_restricted'); await predecessor();
  });
  it.each([
    ['clinical row', async (tx: Inner) => { await tx.query("update clinical_core.organizations set synthetic_label='FICTIONAL altered' where id=$1", [organization]); }],
    ['held reference tail row', async (tx: Inner) => { await tx.query("update clinical_reference.knowledge_sources set review_status='rejected' where stable_id='src_fictional_upgrade_6001'"); }],
    ['old full ledger receipt', async (tx: Inner) => { await tx.query("update clinical_reference.schema_migrations set applied_at=applied_at+interval '1 second' where version='20260819173000'"); }],
  ] as const)('rolls back same-count changes to %s, including beyond a 5k prefix', async (_name, change) => {
    const before = await inspect(); await expect(invoke('upgrade', atReceipt(change))).rejects.toThrow('data_changed');
    expect((await inspect()).observationSha256).toBe(before.observationSha256); await predecessor();
  });
  it.each(['grant select on clinical_core.persons to public', 'grant select on clinical_reference.schema_migrations to public',
    'alter table clinical_core.persons add column unintended text', 'alter table clinical_core.care_data_erasure_intents disable trigger care_data_erasure_intents_immutable',
    'grant usage on schema clinical_private to public', 'alter function clinical_private.care_data_immutable() set search_path=public',
    'create view commercial_reference.catalog_unreviewed_view as select 1 n'])
  ('rolls back unintended schema/ACL change: %s', async sql => {
    const before = await inspect(); await expect(invoke('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('schema_changed');
    expect((await inspect()).observationSha256).toBe(before.observationSha256); await predecessor();
  });
  it.each(['alter table clinical_core.persons disable row level security', 'create table clinical_private.unreviewed_catalog_upgrade(id int)'])
  ('refuses table inventory drift: %s', async sql => {
    await expect(invoke('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('inventory_refused'); await predecessor();
  });
  it.each(['alter policy affiliate_offer_versions_read_active on commercial_reference.affiliate_offer_versions using(true)',
    'create policy catalog_backdoor on commercial_reference.affiliate_offer_versions for select to clinical_core_api using(true)', 'alter role clinical_core_api bypassrls'])
  ('never accepts a weakened policy or bypass role: %s', async sql => {
    await expect(invoke('upgrade', atReceipt(async tx => { await tx.query(sql); }))).rejects.toThrow('policy_refused'); await predecessor();
  });
  it('refuses changed history and successor policy without its receipt', async () => {
    await pg.query("update clinical_core.schema_migrations set name='renamed_alias' where version='20260902230000'");
    try { await expect(inspect()).rejects.toThrow('history_refused'); }
    finally { await pg.query("update clinical_core.schema_migrations set name=$1 where version='20260902230000'", [core.find(m => m.version === '20260821049700')!.name]); }
    try { await pg.exec(candidate.sql); await expect(inspect()).rejects.toThrow('policy_refused'); }
    finally {
      const oldPolicy = reference[0].sql.match(/create policy affiliate_offer_versions_read_active[^]*?;/)![0];
      await pg.exec('drop policy affiliate_offer_versions_read_active on commercial_reference.affiliate_offer_versions;'+oldPolicy);
    } await predecessor();
  });
  it('captures mutable caller input before awaits and refuses a busy migration lock', async () => {
    const suppliedCore = core.map(m => ({ ...m })), suppliedRefs = reference.map(m => ({ ...m })), suppliedCandidate = { ...candidate }, suppliedConfig = { ...configuration };
    const before = await inspect(); let changed = false;
    const result = await runCatalogForwardUpgrade(database(async () => {
      if (changed) return; changed = true; suppliedCandidate.sql += '\nselect 1;'; suppliedCore[0].sql += '\nselect 1;';
      suppliedRefs[0].name = 'changed'; suppliedConfig.databaseName = 'clinical_core_qualification';
    }), suppliedCore, suppliedRefs, suppliedCandidate, suppliedConfig, 'rehearse', before.observationSha256);
    expect(result.rolledBack).toBe(true);
    const busy: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async (sql, args = []) =>
      sql.includes('pg_try_advisory_xact_lock') ? { rows: [{ acquired: false }] } : tx.query(sql, args) } as ClinicalCoreTransaction)) };
    await expect(invoke('upgrade', busy)).rejects.toThrow('upgrade_busy'); await predecessor();
  });
  it('refuses incomplete data fingerprints and redacts provider/SQL failure text', async () => {
    const overBound: ClinicalCoreDatabase = { transaction: work => database().transaction(tx => work({ query: async <Row extends Record<string, unknown>>(sql: string, args: readonly unknown[] = []) => {
      const result = await tx.query<Row>(sql, args);
      return sql.includes('string_agg(row_hash') ? { ...result, rows: result.rows.map(row => row.table_name === 'clinical_reference.knowledge_sources' ? { ...row, row_count: 100001 } : row) } : result;
    } })) };
    await expect(invoke('upgrade', overBound)).rejects.toThrow('inventory_refused');
    await expect(invoke('upgrade', atReceipt(async () => { throw Error('secret credential and provider detail'); }))).rejects.toMatchObject({
      message: 'upgrade_failed', category: 'upgrade_failed', stage: 'ledger_receipt' }); await predecessor();
  });
  it('custodied rollback performs real local SQL and settles only after a separate unchanged inspection', async () => {
    // Two real rollback paths plus independent full-schema/data inspections.
    // Bound the compound test, not the operator's production deadlines.
    const a = CARE_ERASURE_AWS, events: string[] = []; let checks = 0, transactions = 0;
    const d = {
      verifyCustody: () => { checks++; }, record: (stage: string, digest: string) => { expect(digest).toMatch(/^[a-f0-9]{64}$/); events.push(stage); },
      observeCaller: () => ({ Account: a.account, Arn: `arn:aws:sts::${a.account}:assumed-role/FictionalOperator/session` }),
      observeFoundation: () => ({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
        StackId: `arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/fictional`, Outputs: Object.entries({
          PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: a.databaseName,
          ClinicalApiId: a.apiId, DatabaseClusterArn: a.clusterArn, DatabaseSecretArn: a.secretArn,
        }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }),
      loadCore: () => core, loadReference: () => reference, loadCandidate: () => candidate,
      createDatabase: () => ({ transaction: work => { transactions++; return database().transaction(work); } } satisfies ClinicalCoreDatabase),
    };
    const build = { sourceCommit: '1'.repeat(40), clean: true };
    const before = await inspect();
    expect(await executeCatalogForwardRollback(build, d)).toMatchObject({ rolledBack: true, lastingApplyPerformed: false,
      before: { observationSha256: before.observationSha256 }, after: { observationSha256: before.observationSha256 }, phiAllowed: false });
    expect(events).toEqual(['catalog_rollback_admitted', 'catalog_rollback_readback_verified']);
    expect(checks).toBeGreaterThan(40); expect(transactions).toBe(4); await predecessor();
    await expect(executeCatalogForwardRollback({ ...build, clean: false }, d)).rejects.toThrow('boundary_refused');
    const interrupted = { ...d, createDatabase: () => database(async sql => {
      if (sql.startsWith('insert into clinical_reference.schema_migrations')) interrupted.verifyCustody = () => { throw Error('custody_lost'); };
    }) };
    await expect(executeCatalogForwardRollback(build, interrupted)).rejects.toThrow('upgrade_failed');
    expect((await inspect()).observationSha256).toBe(before.observationSha256); await predecessor();
  }, 30_000);
  it('applies once, preserves approvals/holds/history and withdraws only the obsolete offer through actual RLS', async () => {
    const before = await inspect();
    expect(await invoke('upgrade')).toMatchObject({ referenceMigrationCount: 3, applied: true, alreadyApplied: false,
      dataSha256: before.dataSha256, preservedSchemaSha256: before.preservedSchemaSha256 });
    expect((await rawOffers()).map(row => row.offer_stable_id)).toEqual(['off_forward_eligible']);
    expect((await pg.query("select review_status,active_version from commercial_reference.affiliate_offers where stable_id='off_forward_restricted'")).rows[0])
      .toEqual({ review_status: 'approved', active_version: 1 });
    expect((await pg.query<{ review_status: string }>("select review_status from clinical_reference.knowledge_sources where stable_id='src_fictional_upgrade_6001'")).rows[0]?.review_status).toBe('needs_review');
    const after = await inspect(); expect(after.alreadyApplied).toBe(true);
    expect(await invoke('upgrade')).toMatchObject({ applied: false, alreadyApplied: true, observationSha256: after.observationSha256 });
    expect(await invoke('rehearse')).toMatchObject({ rolledBack: true, referenceMigrationCount: 3, observationSha256: after.observationSha256 });
    expect(loadGovernedCatalogMigrations()).toHaveLength(2);
  }, 30_000); // Full upgrade, RLS reads, replay, and rollback in one case.
  it('public inspector observes member STS and the completed exact synthetic foundation, but cannot apply or rehearse', async () => {
    const a = CARE_ERASURE_AWS, calls: string[] = [];
    const dependencies = {
      observeCaller: () => { calls.push('caller'); return { Account: a.account, Arn: `arn:aws:sts::${a.account}:assumed-role/FictionalOperator/session` }; },
      observeFoundation: () => { calls.push('foundation'); return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE',
        StackId: `arn:aws:cloudformation:${a.region}:${a.account}:stack/${a.foundation}/fictional`, Outputs: Object.entries({
          PhiAllowed: 'false', Environment: 'synthetic-staging', DataClassification: 'synthetic_only', DatabaseName: a.databaseName,
          ClinicalApiId: a.apiId, DatabaseClusterArn: a.clusterArn, DatabaseSecretArn: a.secretArn,
        }).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] }; },
      loadCore: () => core, loadReference: () => reference, loadCandidate: () => candidate, createDatabase: () => database(),
    };
    const build = { sourceCommit: '1'.repeat(40), clean: true };
    for (const args of [[], ['upgrade'], ['rehearse'], ['inspect', '--confirm'], ['inspect', '--database', 'clinical_core_qualification']])
      await expect(executeCatalogForwardInspectionCommand(args, build, dependencies)).rejects.toThrow('boundary_refused');
    await expect(executeCatalogForwardInspectionCommand(['inspect'], { ...build, clean: false }, dependencies)).rejects.toThrow('boundary_refused');
    expect(calls).toEqual([]);
    for (const caller of [{ Account: a.account, Arn: `arn:aws:iam::${a.account}:root` },
      { Account: '173535830222', Arn: 'arn:aws:sts::173535830222:assumed-role/FictionalOperator/session' }])
      await expect(executeCatalogForwardInspectionCommand(['inspect'], build, { ...dependencies, observeCaller: () => caller })).rejects.toThrow('boundary_refused');
    const result = await executeCatalogForwardInspectionCommand(['inspect'], build, dependencies);
    expect(calls).toEqual(['caller', 'foundation']);
    expect(result).toMatchObject({ referenceMigrationCount: 3, databaseMutationPerformed: false, apiDeploymentPerformed: false,
      phiActivation: false, hostedAcceptance: false, activationApproved: false });
    const observed = await inspect();
    for (const patch of [{ applied: true }, { activationApproved: true }, { hostedAcceptance: true }, { canonicalRegistered: true },
      { phiAllowed: true }, { referenceLedgerSha256: 'f'.repeat(64) }, { dataPreserved: false }, { tableCount: 88 }]) {
      await expect(executeCatalogForwardInspectionCommand(['inspect'], build, { ...dependencies,
        run: async () => ({ ...observed, ...patch }) as typeof observed })).rejects.toThrow('verification_failed');
    }
  });
  it('uses scalar policy-role output through the actual RDS driver instead of treating ArrayValue as a native array', async () => {
    let returnedArrays = 0;
    const field = (value: unknown): Field => {
      if (value === null || value === undefined) return { isNull: true };
      if (Array.isArray(value)) { returnedArrays++; return { arrayValue: { stringValues: value } }; }
      if (typeof value === 'boolean') return { booleanValue: value };
      if (typeof value === 'number') return Number.isSafeInteger(value) ? { longValue: value } : { doubleValue: value };
      if (typeof value === 'string') return { stringValue: value };
      return { stringValue: JSON.stringify(value) };
    };
    const client = { async send(command: unknown): Promise<Record<string, unknown>> {
      if (command instanceof BeginTransactionCommand) { await pg.exec('begin'); return { transactionId: 'fictional-local-only' }; }
      if (command instanceof CommitTransactionCommand) { await pg.exec('commit'); return {}; }
      if (command instanceof RollbackTransactionCommand) { await pg.exec('rollback'); return {}; }
      if (!(command instanceof ExecuteStatementCommand) || !command.input.sql) throw Error('unexpected fictional SDK command');
      const sql = command.input.sql.replace(/:p(\d+)/g, (_, number) => '$'+number);
      const parameters = (command.input.parameters ?? []).map(p => p.value?.stringValue ?? p.value?.booleanValue ?? p.value?.longValue ?? null);
      const records = sql === 'select current_database() as name' ? [{ name: 'clinical_core' }] : (await pg.query<Record<string, unknown>>(sql, parameters)).rows;
      const names = Object.keys(records[0] ?? {});
      return { columnMetadata: names.map(name => ({ name })), records: records.map(row => names.map(name => field(row[name]))) };
    } };
    const wire = createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn, secretArn: configuration.secretArn,
      databaseName: configuration.databaseName }, { purpose: 'reviewed_synthetic_migration' }, client);
    expect(await inspect(wire)).toMatchObject({ referenceMigrationCount: 3, applied: false, hostedAcceptance: false });
    expect(returnedArrays).toBe(0);
  });
});
