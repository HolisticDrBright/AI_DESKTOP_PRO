import { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventoryRefuse, InventoryQualificationError } from './inventory-qualification-artifacts';
import { assertInventoryQualificationLedger, type InventoryLedgerRow } from './inventory-qualification-ledger';
import { observeInventoryAws, createBoundInventoryRdsClient } from './adopted-plan-inventory-native-ports';
import { qualificationUpgradeFromAws } from './qualification-upgrade-aws-binding';
import { createRdsDataAdministrativeDatabase, RdsDataDatabaseError } from './rds-data-database';
import { inventoryDatabaseIdentityReader } from './inventory-qualification-database-identity';
import { observeFictionalInventoryMapping } from './inventory-qualification-identity-mapping-observer';
import { mapFictionalInventoryIdentities } from './inventory-qualification-identity-mapping';

export type FictionalMappingStage = 'arguments' | 'ledger' | 'source' | 'foundation' | 'identity' | 'repeat_identity'
  | 'repeat_foundation' | 'mapping' | 'after_identity' | 'after_foundation' | 'database_authority' | 'report';
/** Fixed categories only. No provider message, stack, request body, credentials or SQL. */
export function fictionalMappingFailure(error: unknown, failureStage: FictionalMappingStage, writeAdmitted: boolean) {
  const names = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'RdsDataDatabaseError', 'InventoryQualificationError'];
  return { status: 'not_completed', category: error instanceof InventoryQualificationError ? error.category
    : error instanceof RdsDataDatabaseError ? `fictional_mapping_database_${error.category}` : 'fictional_mapping_not_completed',
  failureStage, errorClass: error instanceof Error && names.includes(error.name) ? error.name : 'other', writeAdmitted,
  automaticWriteRetry: false, acceptance: false, phiAllowed: false, activation: 'blocked' };
}

export async function runFictionalInventoryMapping(ledger: InventoryLedgerRow[], sourceCommit: string) {
  let writeAdmitted = false;
  let stage: FictionalMappingStage = 'arguments';
  try {
    const args = process.argv.slice(2).join(' ');
    if (!['inspect', 'map --confirm-fictional-identity-only-mapping'].includes(args)) return inventoryRefuse('fictional_mapping_argument_refused');
    stage = 'ledger'; assertInventoryQualificationLedger('clinical_core_qualification', ledger, ledger);
    stage = 'source';
    const git = (a: string[]) => String(execFileSync('git', a, { encoding: 'utf8', timeout: 10000, windowsHide: true })).trim();
    if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(['rev-parse', 'HEAD']) !== sourceCommit || git(['status', '--porcelain', '--untracked-files=normal']))
      return inventoryRefuse('fictional_mapping_clean_source_required');
    stage = 'foundation';
    const configuration = qualificationUpgradeFromAws(observeInventoryAws('caller'), observeInventoryAws('foundation'));
    stage = 'identity';
    const mapping = await observeFictionalInventoryMapping();
    const database = { DatabaseName: configuration.qualificationDatabaseName, DatabaseClusterArn: configuration.clusterArn, DatabaseSecretArn: configuration.secretArn };
    let mapped: unknown = null;
    if (args.startsWith('map ')) {
      stage = 'repeat_identity';
      const repeated = await observeFictionalInventoryMapping();
      if (inventoryCanonical(mapping) !== inventoryCanonical(repeated)) return inventoryRefuse('fictional_mapping_observation_changed');
      stage = 'repeat_foundation';
      const fresh = qualificationUpgradeFromAws(observeInventoryAws('caller'), observeInventoryAws('foundation'));
      if (inventoryCanonical(fresh) !== inventoryCanonical(configuration)) return inventoryRefuse('fictional_mapping_target_changed');
      writeAdmitted = true;
      stage = 'mapping';
      mapped = await mapFictionalInventoryIdentities(createRdsDataAdministrativeDatabase({ clusterArn: configuration.clusterArn,
        secretArn: configuration.secretArn, databaseName: configuration.qualificationDatabaseName, region: 'us-east-2' },
      { purpose: 'reviewed_synthetic_migration' }, createBoundInventoryRdsClient(configuration)), mapping, ledger);
    }
    stage = 'after_identity';
    const after = await observeFictionalInventoryMapping();
    if (inventoryCanonical(mapping) !== inventoryCanonical(after)) return inventoryRefuse('fictional_mapping_observation_changed');
    stage = 'after_foundation';
    const current = qualificationUpgradeFromAws(observeInventoryAws('caller'), observeInventoryAws('foundation'));
    if (inventoryCanonical(current) !== inventoryCanonical(configuration)) return inventoryRefuse('fictional_mapping_target_changed');
    stage = 'database_authority';
    const result = await inventoryDatabaseIdentityReader(ledger)({ database, organizationId: mapping.organizationId, subjects: mapping.subjects,
      cognitoPersonBindingsSha256: mapping.personBindingsSha256 });
    stage = 'report';
    console.log(JSON.stringify({ contract: 'inventory-qualification-identity-mapping-command/1', sourceCommit,
      command: args.startsWith('map ') ? 'map' : 'inspect', execution: 'qualification', mapped, observation: result,
      identityDependenciesVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, activation: 'blocked' }));
  } catch (error) {
    console.error(JSON.stringify(fictionalMappingFailure(error, stage, writeAdmitted)));
    process.exitCode = 1;
  }
}
