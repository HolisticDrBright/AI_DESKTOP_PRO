if (typeof window !== 'undefined') throw new Error('catalog-forward-apply-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import { CARE_ERASURE_AWS, careErasureUpgradeFromAws, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';
import { executeCatalogForwardInspectionCommand, type CatalogForwardInspectionBuild } from './catalog-forward-inspection-command';
import { type CatalogRollbackDependencies } from './catalog-forward-rehearsal-command';
import { CATALOG_FORWARD_UPGRADE, CatalogForwardUpgradeError, catalogForwardObservationSha256, runCatalogForwardUpgrade,
  type CatalogForwardObservation } from './catalog-forward-upgrade';

type Inspection = Awaited<ReturnType<typeof executeCatalogForwardInspectionCommand>>;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const refuse = (): never => { throw new CatalogForwardUpgradeError('verification_failed', 'apply_readback'); };
const fixedConfiguration: CareErasureUpgradeConfiguration = {
  account: CARE_ERASURE_AWS.account, region: CARE_ERASURE_AWS.region, clusterArn: CARE_ERASURE_AWS.clusterArn,
  secretArn: CARE_ERASURE_AWS.secretArn, databaseName: CARE_ERASURE_AWS.databaseName,
  environment: 'synthetic-staging', dataClassification: 'synthetic_only', phiAllowed: false,
};

/** Exactly one reference receipt and one separately checked policy can change.
 * No caller boolean can stand in for the independently opened inspection. */
export function assertCatalogForwardApplyReadback(before: Inspection, after: Inspection) {
  const successor = before.referenceMigrationCount === 3;
  if (before.contract !== 'catalog-forward-upgrade/1' || before.execution !== 'synthetic-staging'
    || before.tableCount !== 89 || !Number.isSafeInteger(before.rowCount) || before.rowCount < 0
    || ![before.dataSha256, before.preservedSchemaSha256, before.observationSha256].every(hash => /^[a-f0-9]{64}$/.test(hash))
    || before.observationSha256 !== catalogForwardObservationSha256(fixedConfiguration, before.dataSha256, before.preservedSchemaSha256, successor)
    || before.dataPreserved !== true || before.schemaPreserved !== true || before.historicalLedgerPreserved !== true
    || before.awsAccountId !== CARE_ERASURE_AWS.account || before.foundation !== CARE_ERASURE_AWS.foundation
    || before.operatorSource?.clean !== true || !/^[a-f0-9]{40}$/.test(before.operatorSource.sourceCommit)) refuse();
  if (!equal(before, { ...before, command: 'inspect', applied: false, rolledBack: false, alreadyApplied: successor,
    coreLedgerSha256: CATALOG_FORWARD_UPGRADE.liveCoreSha256, referenceMigrationCount: successor ? 3 : 2,
    referenceLedgerSha256: successor ? CATALOG_FORWARD_UPGRADE.referenceAfterSha256 : CATALOG_FORWARD_UPGRADE.referenceBeforeSha256,
    candidateSqlSha256: CATALOG_FORWARD_UPGRADE.sqlSha256, phiAllowed: false, canonicalRegistered: false,
    hostedAcceptance: false, activationApproved: false, databaseMutationPerformed: false, apiDeploymentPerformed: false, phiActivation: false })) refuse();
  const expected = { ...before, referenceMigrationCount: 3, referenceLedgerSha256: CATALOG_FORWARD_UPGRADE.referenceAfterSha256,
    alreadyApplied: true, observationSha256: catalogForwardObservationSha256(fixedConfiguration, before.dataSha256, before.preservedSchemaSha256, true) };
  if (!equal(after, expected)) refuse();
}

/** Only the fixed, synthetic preserving apply. Shared routing custody and
 * durable admission are required by the public wrapper. This does not register
 * a canonical runtime, deploy an API or approve PHI. Uncertain commit/readback
 * leaves custody unresolved; an ordinary retry is not reconciliation. */
export async function executeCatalogForwardApply(suppliedBuild: CatalogForwardInspectionBuild, supplied: CatalogRollbackDependencies) {
  const build = { ...suppliedBuild };
  supplied.verifyCustody();
  // Capture admitted inputs before the first await, not again after inspection.
  const core = supplied.loadCore().map(m => ({ ...m })), reference = supplied.loadReference().map(m => ({ ...m }));
  const candidate = { ...supplied.loadCandidate() };
  const d = { ...supplied, loadCore: () => core.map(m => ({ ...m })), loadReference: () => reference.map(m => ({ ...m })), loadCandidate: () => ({ ...candidate }) };
  const before = await executeCatalogForwardInspectionCommand(['inspect'], build, d);
  d.verifyCustody(); d.record('catalog_apply_admitted', before.observationSha256);
  // Re-observe identity and foundation; every statement checks the same custody.
  const configuration = careErasureUpgradeFromAws(d.observeCaller(), d.observeFoundation());
  const database = d.createDatabase(configuration);
  const guarded: ClinicalCoreDatabase = { transaction: work => {
    d.verifyCustody();
    return database.transaction(tx => work({ query: (sql, args) => { d.verifyCustody(); return tx.query(sql, args); } }));
  } };
  const applied = await (d.run ?? runCatalogForwardUpgrade)(guarded, core, reference, candidate, configuration, 'upgrade', before.observationSha256);
  // The writer's result is not the independent readback. Compare every field,
  // including preserved rows/schema, before opening the separate transaction.
  const oldObservation = { ...before } as Partial<Inspection>;
  for (const key of ['operatorSource', 'awsAccountId', 'foundation', 'databaseMutationPerformed', 'apiDeploymentPerformed', 'phiActivation'] as const)
    delete oldObservation[key];
  const expected: CatalogForwardObservation = { ...oldObservation as CatalogForwardObservation, command: 'upgrade',
    referenceMigrationCount: 3, referenceLedgerSha256: CATALOG_FORWARD_UPGRADE.referenceAfterSha256,
    applied: before.referenceMigrationCount === 2, alreadyApplied: before.referenceMigrationCount === 3,
    observationSha256: catalogForwardObservationSha256(configuration, before.dataSha256, before.preservedSchemaSha256, true) };
  if (!equal(applied, expected)) refuse();
  d.verifyCustody(); d.record('catalog_apply_committed', applied.observationSha256);
  const after = await executeCatalogForwardInspectionCommand(['inspect'], build, d);
  assertCatalogForwardApplyReadback(before, after);
  d.verifyCustody(); d.record('catalog_apply_readback_verified', after.observationSha256);
  return { contract: 'catalog-forward-preserving-apply/1' as const, before, after,
    applied: applied.applied, alreadyApplied: applied.alreadyApplied, independentReadbackVerified: true,
    dataPreserved: true, schemaPreserved: true, historicalLedgerPreserved: true,
    lastingApplyPerformed: applied.applied, apiDeploymentPerformed: false, canonicalRegistered: false,
    hostedAcceptance: false, activationApproved: false, phiAllowed: false };
}
