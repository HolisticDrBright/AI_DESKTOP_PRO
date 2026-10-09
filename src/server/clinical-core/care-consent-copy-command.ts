if (typeof window !== 'undefined') throw new Error('care-consent-copy-command is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { QualificationUpgradeConfiguration } from './qualification-schema-upgrade';
import { qualificationUpgradeFromAws, QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { CARE_CONNECTIONS_UPGRADE } from './care-connections-schema-upgrade';
import { CARE_CLAIM_RECOVERY_UPGRADE } from './care-claim-recovery-schema-upgrade';
import { assertCareConsentCopyRelease, CareConsentCopyError, parseCareConsentCopy, runCareConsentCopyRegistration, type CareConsentCopyMode } from './care-consent-copy-registration';
export type CareConsentCopyBuild = { sourceCommit: string; clean: boolean };
export type CareConsentCopyDependencies = { readCopy: (path: string) => unknown; loadMigrations: () => ClinicalCoreMigration[];
  observeCaller: () => unknown; observeFoundation: () => unknown;
  createDatabase: (configuration: QualificationUpgradeConfiguration) => ClinicalCoreDatabase;
  run?: typeof runCareConsentCopyRegistration };
const confirm = '--confirm-fictional-consent-copy-registration';
/** No profile, database, target, approval or PHI override. Args are parsed before
 * reading the input, observing AWS, touching a secret or starting a transaction. */
export async function executeCareConsentCopyCommand(args: readonly string[], suppliedBuild: CareConsentCopyBuild,
  dependencies: CareConsentCopyDependencies) {
  const build = { ...suppliedBuild }, [command, file, confirmation, ...extra] = args;
  const write = command === 'register' || command === 'rehearse';
  if (!['inventory', 'inspect', 'register', 'rehearse'].includes(command) || extra.length
    || !/^[a-f0-9]{40}$/.test(build.sourceCommit) || typeof build.clean !== 'boolean'
    || command === 'inventory' && args.length !== 1
    || command !== 'inventory' && (!file?.startsWith('--copy-file=') || !file.slice(12)
      || write && (confirmation !== confirm || !build.clean) || !write && args.length !== 2))
    throw new CareConsentCopyError('copy_invalid');
  const copy = command === 'inventory' ? undefined : parseCareConsentCopy(dependencies.readCopy(file.slice(12)));
  const migrations = dependencies.loadMigrations().map(m => ({ ...m }));
  const caller = dependencies.observeCaller();
  const transition = migrations.length === 105 ? CARE_CONNECTIONS_UPGRADE : CARE_CLAIM_RECOVERY_UPGRADE;
  const configuration = { ...qualificationUpgradeFromAws(caller, dependencies.observeFoundation()),
    fromReleaseSha256: transition.from, toReleaseSha256: transition.to };
  const { Account, Arn } = caller as { Account: string; Arn: string };
  const operatorPrincipalSha256 = createHash('sha256').update(JSON.stringify({ Account, Arn })).digest('hex');
  assertCareConsentCopyRelease(configuration, migrations);
  const database = dependencies.createDatabase(configuration), run = dependencies.run ?? runCareConsentCopyRegistration;
  const rehearsal = command === 'register' ? await run(database, migrations, configuration, 'rehearse', copy) : undefined;
  if (rehearsal && rehearsal.rolledBack !== true) throw new CareConsentCopyError('verification_failed');
  const result = await run(database, migrations, configuration, command as CareConsentCopyMode, copy);
  // A content-free session digest attributes the CLI receipt, not approval of copy.
  return { ...result, operatorSource: build, operatorPrincipalSha256,
    foundation: QUALIFICATION_UPGRADE_AWS.foundation, awsAccountId: QUALIFICATION_UPGRADE_AWS.account,
    rehearsal: rehearsal ? { rolledBack: rehearsal.rolledBack, copyPresent: rehearsal.copyPresent } : null };
}
