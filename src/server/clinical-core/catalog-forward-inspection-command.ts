if (typeof window !== 'undefined') throw new Error('catalog-forward-inspection-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { CARE_ERASURE_AWS, careErasureUpgradeFromAws, type CareErasureUpgradeConfiguration } from './care-erasure-schema-upgrade';
import { CATALOG_FORWARD_UPGRADE, CatalogForwardUpgradeError, catalogForwardMapping, runCatalogForwardUpgrade } from './catalog-forward-upgrade';

export type CatalogForwardInspectionBuild = { sourceCommit: string; clean: boolean };
export type CatalogForwardInspectionDependencies = {
  observeCaller: () => unknown; observeFoundation: () => unknown;
  loadCore: () => ClinicalCoreMigration[]; loadReference: () => ClinicalCoreMigration[]; loadCandidate: () => ClinicalCoreMigration;
  createDatabase: (configuration: CareErasureUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runCatalogForwardUpgrade;
};
/** Read-only inspector only. No confirmation, environment switch or supplied
 * receipt can unlock a lasting operation. The preserving apply/rehearsal
 * library remains a source candidate for a separately custodied release. */
export async function executeCatalogForwardInspectionCommand(args: readonly string[], suppliedBuild: CatalogForwardInspectionBuild,
  dependencies: CatalogForwardInspectionDependencies) {
  const build = { ...suppliedBuild };
  if (args.length !== 1 || args[0] !== 'inspect' || build.clean !== true || !/^[a-f0-9]{40}$/.test(build.sourceCommit))
    throw new CatalogForwardUpgradeError('boundary_refused');
  let configuration: CareErasureUpgradeConfiguration;
  try {
    const observed = dependencies.observeCaller();
    const caller = observed && typeof observed === 'object' && !Array.isArray(observed) ? observed as { Account?: unknown; Arn?: unknown } : null;
    if (!caller || caller.Account !== CARE_ERASURE_AWS.account || typeof caller.Arn !== 'string'
      || !/^arn:aws:sts::588966314750:assumed-role\/[A-Za-z0-9_+=,.@/-]+$/.test(caller.Arn))
      throw new CatalogForwardUpgradeError('boundary_refused');
    configuration = careErasureUpgradeFromAws(observed, dependencies.observeFoundation());
  }
  catch { throw new CatalogForwardUpgradeError('boundary_refused'); }
  const core = dependencies.loadCore().map(m => ({ ...m })), reference = dependencies.loadReference().map(m => ({ ...m }));
  const candidate = { ...dependencies.loadCandidate() };
  const mapping = catalogForwardMapping(core, reference, candidate, configuration);
  const result = await (dependencies.run ?? runCatalogForwardUpgrade)(dependencies.createDatabase({ ...configuration }),
    core, reference, candidate, { ...configuration }, 'inspect');
  const successor = result.referenceMigrationCount === 3;
  if (result.contract !== 'catalog-forward-upgrade/1' || result.command !== 'inspect' || result.execution !== 'synthetic-staging'
    || result.phiAllowed !== false || result.coreLedgerSha256 !== CATALOG_FORWARD_UPGRADE.liveCoreSha256
    || ![2, 3].includes(result.referenceMigrationCount) || result.referenceLedgerSha256 !== (successor ? mapping.referenceAfterSha256 : CATALOG_FORWARD_UPGRADE.referenceBeforeSha256)
    || result.candidateSqlSha256 !== candidate.sha256 || result.tableCount !== 89 || !Number.isSafeInteger(result.rowCount) || result.rowCount < 0
    || ![result.dataSha256, result.preservedSchemaSha256, result.observationSha256].every(hash => /^[a-f0-9]{64}$/.test(hash))
    || result.dataPreserved !== true || result.schemaPreserved !== true || result.historicalLedgerPreserved !== true
    || result.applied !== false || result.alreadyApplied !== successor || result.rolledBack !== false
    || result.canonicalRegistered !== false || result.hostedAcceptance !== false || result.activationApproved !== false)
    throw new CatalogForwardUpgradeError('verification_failed');
  return { ...result, operatorSource: build, awsAccountId: CARE_ERASURE_AWS.account,
    foundation: CARE_ERASURE_AWS.foundation, databaseMutationPerformed: false, apiDeploymentPerformed: false, phiActivation: false };
}
