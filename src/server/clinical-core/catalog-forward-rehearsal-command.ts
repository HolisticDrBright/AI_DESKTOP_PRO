if (typeof window !== 'undefined') throw new Error('catalog-forward-rehearsal-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { CatalogForwardInspectionBuild, CatalogForwardInspectionDependencies } from './catalog-forward-inspection-command';
import { executeCatalogForwardInspectionCommand } from './catalog-forward-inspection-command';
import { CatalogForwardUpgradeError, runCatalogForwardUpgrade } from './catalog-forward-upgrade';
import { careErasureUpgradeFromAws } from './care-erasure-schema-upgrade';

export type CatalogRollbackDependencies = CatalogForwardInspectionDependencies & {
  verifyCustody: () => void;
  record: (stage: string, observationSha256: string) => void;
};
/** Only a preserving rollback rehearsal. A successful return is not registration,
 * a lasting apply, a compatible runtime deployment or production authority. */
export async function executeCatalogForwardRollback(build: CatalogForwardInspectionBuild, d: CatalogRollbackDependencies) {
  d.verifyCustody();
  // The independent inspector performs the member-account, foundation and
  // complete artifact checks before a database factory can be reached.
  const before = await executeCatalogForwardInspectionCommand(['inspect'], build, d);
  if (before.referenceMigrationCount !== 2 || before.alreadyApplied !== false)
    throw new CatalogForwardUpgradeError('history_refused');
  d.verifyCustody(); d.record('catalog_rollback_admitted', before.observationSha256);
  const configuration = careErasureUpgradeFromAws(d.observeCaller(), d.observeFoundation());
  const database = d.createDatabase(configuration);
  const guarded: ClinicalCoreDatabase = { transaction: work => {
    d.verifyCustody();
    return database.transaction(tx => work({ query: (sql, args) => {
      d.verifyCustody(); return tx.query(sql, args);
    } }));
  } };
  const rehearsal = await runCatalogForwardUpgrade(guarded, d.loadCore(), d.loadReference(), d.loadCandidate(),
    configuration, 'rehearse', before.observationSha256);
  if (rehearsal.command !== 'rehearse' || rehearsal.rolledBack !== true || rehearsal.applied !== false
    || rehearsal.alreadyApplied !== false || rehearsal.referenceMigrationCount !== 2
    || rehearsal.observationSha256 !== before.observationSha256)
    throw new CatalogForwardUpgradeError('verification_failed');
  d.verifyCustody();
  // A separately opened transaction after rollback is mandatory. Never settle
  // custody from the library's in-transaction successor or a supplied receipt.
  const after = await executeCatalogForwardInspectionCommand(['inspect'], build, d);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new CatalogForwardUpgradeError('verification_failed');
  d.verifyCustody(); d.record('catalog_rollback_readback_verified', after.observationSha256);
  return { contract: 'catalog-forward-rollback-rehearsal/1' as const, before, after,
    rolledBack: true, dataPreserved: true, schemaPreserved: true, historicalLedgerPreserved: true,
    lastingApplyPerformed: false, apiDeploymentPerformed: false, canonicalRegistered: false,
    hostedAcceptance: false, activationApproved: false, phiAllowed: false };
}
