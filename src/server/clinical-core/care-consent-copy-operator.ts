if (typeof window !== 'undefined') throw new Error('care-consent-copy-operator is server-only');
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { createSingleAttemptRdsClient } from './rds-single-attempt-client';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { loadClinicalCoreMigrations } from './migrations';
import { QUALIFICATION_UPGRADE_AWS } from './qualification-upgrade-aws-binding';
import { CareConsentCopyError } from './care-consent-copy-registration';
import { CareConnectionsUpgradeError } from './care-connections-schema-upgrade';
import { executeCareConsentCopyCommand, type CareConsentCopyBuild } from './care-consent-copy-command';
declare const __CARE_CONSENT_COPY_BUILD__: CareConsentCopyBuild;
const { profile, region, foundation } = QUALIFICATION_UPGRADE_AWS;
const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
function readCopy(path: string): unknown {
  if (!isAbsolute(path)) throw new CareConsentCopyError('copy_invalid');
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new CareConsentCopyError('copy_invalid');
    const bytes = Buffer.alloc(65537); let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break; length += read;
    }
    if (length !== stat.size || length > 65536) throw new CareConsentCopyError('copy_invalid');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { closeSync(fd); }
}
executeCareConsentCopyCommand(process.argv.slice(2), __CARE_CONSENT_COPY_BUILD__, {
  readCopy, loadMigrations: () => loadClinicalCoreMigrations('dist/aws-clinical-core/production-migrations'),
  observeCaller: () => aws(['sts', 'get-caller-identity']),
  observeFoundation: () => aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]),
  createDatabase: c => createRdsDataAdministrativeDatabase({ clusterArn: c.clusterArn, secretArn: c.secretArn,
    databaseName: c.qualificationDatabaseName, region }, { purpose: 'reviewed_consent_copy_registration' },
    createSingleAttemptRdsClient({ region, credentials: fromIni({ profile }) })),
}).then(receipt => { console.log(JSON.stringify(receipt)); }).catch(error => {
  // Never print a file, payload, SQL/provider error or an uncertain success claim.
  const category = error instanceof CareConsentCopyError || error instanceof CareConnectionsUpgradeError ? error.category : 'operation_failed';
  console.error(JSON.stringify({ status: 'not_completed', category, phiAllowed: false, activation: 'blocked', writeStatus: 'not_certified' }));
  process.exitCode = 1;
});
