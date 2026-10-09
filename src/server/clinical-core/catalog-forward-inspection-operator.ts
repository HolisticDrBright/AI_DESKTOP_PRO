if (typeof window !== 'undefined') throw new Error('catalog-forward-inspection-operator is server-only');
import { execFileSync } from 'node:child_process';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import type { ClinicalCoreMigration } from './migrations';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { CARE_ERASURE_AWS } from './care-erasure-schema-upgrade';
import { CatalogForwardUpgradeError } from './catalog-forward-upgrade';
import { createCareErasureOperatorClient } from './care-erasure-operator-client';
import { executeCatalogForwardInspectionCommand, type CatalogForwardInspectionBuild } from './catalog-forward-inspection-command';

declare const __CATALOG_FORWARD_BUILD__: CatalogForwardInspectionBuild;
declare const __CATALOG_FORWARD_CORE__: ClinicalCoreMigration[];
declare const __CATALOG_FORWARD_REFERENCE__: ClinicalCoreMigration[];
declare const __CATALOG_FORWARD_CANDIDATE__: ClinicalCoreMigration;
const { profile, region, foundation } = CARE_ERASURE_AWS;
let client: RDSDataClient | undefined;
let transport: ReturnType<typeof createCareErasureOperatorClient> | undefined;
const aws = (args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', profile, '--region', region, '--output', 'json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
executeCatalogForwardInspectionCommand(process.argv.slice(2), __CATALOG_FORWARD_BUILD__, {
  observeCaller: () => aws(['sts', 'get-caller-identity']),
  observeFoundation: () => aws(['cloudformation', 'describe-stacks', '--stack-name', foundation]),
  loadCore: () => __CATALOG_FORWARD_CORE__, loadReference: () => __CATALOG_FORWARD_REFERENCE__, loadCandidate: () => __CATALOG_FORWARD_CANDIDATE__,
  createDatabase: configuration => {
    client = new RDSDataClient({ region, credentials: fromIni({ profile }), maxAttempts: 1,
      requestHandler: { httpsAgent: { keepAlive: false, maxSockets: 1 }, connectionTimeout: 10000, requestTimeout: 30000 } });
    transport = createCareErasureOperatorClient(client);
    return createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn, secretArn: configuration.secretArn,
      databaseName: configuration.databaseName, region }, { purpose: 'reviewed_synthetic_migration' }, transport.client);
  },
}).then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(error instanceof CatalogForwardUpgradeError
    ? `${error.category}${error.stage ? ':' + error.stage : ''}${transport?.failure() ? ':' + transport.failure() : ''}` : 'catalog_forward_inspection_failed');
  process.exitCode = 1;
}).finally(() => { client?.destroy(); });
