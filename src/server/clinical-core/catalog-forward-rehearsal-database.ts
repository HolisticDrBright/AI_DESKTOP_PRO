if (typeof window !== 'undefined') throw new Error('catalog-forward-rehearsal-database is server-only');
import { execFileSync } from 'node:child_process';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import type { ClinicalCoreMigration } from './migrations';
import type { CatalogForwardInspectionBuild } from './catalog-forward-inspection-command';
import { CARE_ERASURE_AWS } from './care-erasure-schema-upgrade';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { createCareErasureOperatorClient } from './care-erasure-operator-client';
import { executeCatalogForwardRollback } from './catalog-forward-rehearsal-command';
import { executeCatalogForwardInspectionCommand } from './catalog-forward-inspection-command';

declare const __CATALOG_FORWARD_BUILD__: CatalogForwardInspectionBuild;
declare const __CATALOG_FORWARD_CORE__: ClinicalCoreMigration[];
declare const __CATALOG_FORWARD_REFERENCE__: ClinicalCoreMigration[];
declare const __CATALOG_FORWARD_CANDIDATE__: ClinicalCoreMigration;
// Deliberately no executable CLI and no lasting-upgrade export.
async function executeDatabase(sourceCommit: string, custody: {
  verify: () => void; record: (stage: string, observationSha256: string) => void;
}, inspect: boolean) {
  if (sourceCommit !== __CATALOG_FORWARD_BUILD__.sourceCommit) throw new Error('catalog_forward_source_mismatch');
  const clients: RDSDataClient[] = [];
  const aws = (args: string[]) => {
    custody.verify();
    if (Object.entries(process.env).some(([key, value]) => /^AWS_ENDPOINT_URL(?:_|$)/.test(key) && value))
      throw new Error('catalog_forward_endpoint_override');
    return JSON.parse(execFileSync('aws', [...args, '--profile', CARE_ERASURE_AWS.profile, '--region', CARE_ERASURE_AWS.region,
      '--output', 'json', '--no-cli-pager'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard', AWS_PAGER: '' } }));
  };
  const dependencies = {
    verifyCustody: custody.verify, record: custody.record,
    observeCaller: () => aws(['sts', 'get-caller-identity']),
    observeFoundation: () => aws(['cloudformation', 'describe-stacks', '--stack-name', CARE_ERASURE_AWS.foundation]),
    loadCore: () => __CATALOG_FORWARD_CORE__, loadReference: () => __CATALOG_FORWARD_REFERENCE__,
    loadCandidate: () => __CATALOG_FORWARD_CANDIDATE__,
    createDatabase: (configuration: import('./care-erasure-schema-upgrade').CareErasureUpgradeConfiguration) => {
      custody.verify();
      const client = new RDSDataClient({ region: CARE_ERASURE_AWS.region, credentials: fromIni({ profile: CARE_ERASURE_AWS.profile }),
        maxAttempts: 1, requestHandler: { httpsAgent: { keepAlive: false, maxSockets: 1 }, connectionTimeout: 10000, requestTimeout: 30000 } });
      clients.push(client);
      const transport = createCareErasureOperatorClient(client);
      return createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn, secretArn: configuration.secretArn,
        databaseName: configuration.databaseName, region: configuration.region }, { purpose: 'reviewed_synthetic_migration' }, transport.client);
    },
  };
  try { return inspect ? await executeCatalogForwardInspectionCommand(['inspect'], __CATALOG_FORWARD_BUILD__, dependencies)
    : await executeCatalogForwardRollback(__CATALOG_FORWARD_BUILD__, dependencies);
  } finally { clients.forEach(client => client.destroy()); }
}
export const inspectCatalogForwardDatabase = (sourceCommit: string, custody: Parameters<typeof executeDatabase>[1]) => executeDatabase(sourceCommit, custody, true);
export const rehearseCatalogForwardDatabase = (sourceCommit: string, custody: Parameters<typeof executeDatabase>[1]) => executeDatabase(sourceCommit, custody, false);
