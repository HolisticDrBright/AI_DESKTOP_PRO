if (typeof window !== 'undefined') throw new Error('care-erasure-upgrade-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { CARE_ERASURE_AWS, CARE_ERASURE_UPGRADE, CareErasureUpgradeError, assertCareErasureUpgrade,
  careErasureUpgradeFromAws, runCareErasureSchemaUpgrade, type CareErasureUpgradeConfiguration,
  type CareErasureUpgradeResult } from './care-erasure-schema-upgrade';
export type CareErasureUpgradeBuild = { sourceCommit: string; clean: boolean };
export type CareErasureUpgradeDependencies = {
  observeCaller: () => unknown; observeFoundation: () => unknown;
  loadMigrations: () => ClinicalCoreMigration[]; loadReferenceMigrations: () => ClinicalCoreMigration[];
  createDatabase: (c: CareErasureUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runCareErasureSchemaUpgrade;
};
const refuse = (): never => { throw new CareErasureUpgradeError('boundary_refused'); };
function verify(r: CareErasureUpgradeResult, command: 'inspect' | 'rehearse' | 'upgrade') {
  const count = r.observedMigrationCount;
  if (r.contract !== 'care-erasure-schema-upgrade/1' || r.execution !== 'synthetic-staging' || r.phiAllowed !== false
    || r.command !== command || ![46, 47].includes(count) || r.sourceMigrationCount !== count - 1
    || r.tableCount !== (count === 46 ? 87 : 88) || r.dataPreserved !== true || !/^[a-f0-9]{64}$/.test(r.dataSha256)
    || !Number.isSafeInteger(r.rowCount) || r.rowCount < 0 || typeof r.alreadyApplied !== 'boolean' || typeof r.applied !== 'boolean'
    || r.fromLedgerSha256 !== CARE_ERASURE_UPGRADE.liveBefore || r.toLedgerSha256 !== CARE_ERASURE_UPGRADE.liveAfter
    || r.referenceLedgerSha256 !== CARE_ERASURE_UPGRADE.reference || r.rolledBack !== (command === 'rehearse')
    || command !== 'upgrade' && r.applied !== false || command === 'upgrade' && (count !== 47 || r.applied !== !r.alreadyApplied))
    throw new CareErasureUpgradeError('verification_failed');
}
/** Embedded artifacts and observed fixed member/foundation; upgrade always rehearses
 * and re-observes before its preserving transaction. No skip, target or review override. */
export async function executeCareErasureUpgradeCommand(args: readonly string[], suppliedBuild: CareErasureUpgradeBuild,
  d: CareErasureUpgradeDependencies) {
  const build = { ...suppliedBuild }, [command, confirm, ...extra] = args;
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command) || !/^[a-f0-9]{40}$/.test(build.sourceCommit)
    || typeof build.clean !== 'boolean' || command === 'inspect' && confirm !== undefined
    || command !== 'inspect' && (!build.clean || confirm !== '--confirm-fictional-care-erasure-upgrade')) refuse();
  const c = careErasureUpgradeFromAws(d.observeCaller(), d.observeFoundation());
  const m = d.loadMigrations().map(x => ({ ...x })), reference = d.loadReferenceMigrations().map(x => ({ ...x }));
  assertCareErasureUpgrade(c, m, reference);
  const database = d.createDatabase({ ...c }), run = d.run ?? runCareErasureSchemaUpgrade;
  const invoke = (mode: 'inspect' | 'rehearse' | 'upgrade') => run(database, m.map(x => ({ ...x })),
    reference.map(x => ({ ...x })), { ...c }, mode);
  let rehearsal: CareErasureUpgradeResult | null = null;
  if (command === 'upgrade') {
    rehearsal = await invoke('rehearse'); verify(rehearsal, 'rehearse');
    const current = careErasureUpgradeFromAws(d.observeCaller(), d.observeFoundation());
    if (JSON.stringify(current) !== JSON.stringify(c)) refuse();
    assertCareErasureUpgrade(c, m, reference);
  }
  const result = await invoke(command as 'inspect' | 'rehearse' | 'upgrade');
  verify(result, command as 'inspect' | 'rehearse' | 'upgrade');
  return { ...result, operatorSource: build, awsAccountId: CARE_ERASURE_AWS.account, foundation: CARE_ERASURE_AWS.foundation,
    rehearsal: rehearsal ? { rolledBack: true, rowCount: rehearsal.rowCount, dataSha256: rehearsal.dataSha256 } : null,
    acceptance: false, phiActivation: false, apiDeploymentPerformed: false };
}
