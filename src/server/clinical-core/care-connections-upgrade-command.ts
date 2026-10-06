if (typeof window !== 'undefined') throw new Error('care-connections-upgrade-command is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { CARE_CONNECTIONS_UPGRADE, CareConnectionsUpgradeError, assertCareConnectionsUpgrade, runCareConnectionsSchemaUpgrade } from './care-connections-schema-upgrade';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';

export type CareConnectionsUpgradeBuild = { sourceCommit: string; clean: boolean };
export type CareConnectionsUpgradeDependencies = {
  observeCaller: () => unknown;
  observeFoundation: () => unknown;
  loadMigrations: () => ClinicalCoreMigration[];
  createDatabase: (configuration: QualificationUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runCareConnectionsSchemaUpgrade;
};

/** The shipped entry point has no target, profile, release or approval override.
 * Dependency injection is for credential-free tests, not CLI arguments. */
export async function executeCareConnectionsUpgradeCommand(args: readonly string[], suppliedBuild: CareConnectionsUpgradeBuild,
  dependencies: CareConnectionsUpgradeDependencies) {
  const build = { ...suppliedBuild };
  const [command, confirmation, ...extra] = args;
  if (extra.length || !['inspect', 'rehearse', 'upgrade'].includes(command)
    || !/^[a-f0-9]{40}$/.test(build.sourceCommit) || typeof build.clean !== 'boolean'
    || command === 'inspect' && confirmation !== undefined
    || command !== 'inspect' && (confirmation !== '--confirm-fictional-care-connections-upgrade' || !build.clean)) {
    throw new CareConnectionsUpgradeError('boundary_refused');
  }
  // These observations are fetched by the CLI itself using one fixed member
  // profile. Root, production, unfinished foundation and staging are refused.
  const observed = qualificationUpgradeFromAws(dependencies.observeCaller(), dependencies.observeFoundation());
  const configuration = { ...observed, fromReleaseSha256: CARE_CONNECTIONS_UPGRADE.from, toReleaseSha256: CARE_CONNECTIONS_UPGRADE.to };
  const migrations = dependencies.loadMigrations().map(m => ({ ...m }));
  assertCareConnectionsUpgrade(configuration, migrations); // no data client before exact release admission
  const database = dependencies.createDatabase(configuration);
  const run = dependencies.run ?? runCareConnectionsSchemaUpgrade;
  const rehearsal = command === 'upgrade' ? await run(database, migrations, configuration, 'rehearse') : undefined;
  if (rehearsal && rehearsal.rolledBack !== true) throw new CareConnectionsUpgradeError('verification_failed');
  const result = await run(database, migrations, configuration, command as 'inspect' | 'rehearse' | 'upgrade');
  return { ...result, rehearsal: rehearsal ? { rolledBack: rehearsal.rolledBack, dataSha256: rehearsal.dataSha256 } : null,
    operatorSource: build, foundation: QUALIFICATION_UPGRADE_AWS.foundation, awsAccountId: QUALIFICATION_UPGRADE_AWS.account };
}
