if (typeof window !== 'undefined') throw Error('fullscript-upgrade-native-ports is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { FullscriptUpgradeDependencies } from './fullscript-upgrade-command';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { createBoundInventoryRdsClient, observeInventoryAws } from './adopted-plan-inventory-native-ports';
import { withInventoryOperatorFence } from './adopted-plan-inventory-operator-fence';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import { FULLSCRIPT_OPERATOR_SHARED_ROOT, createNativeFullscriptCustody, openNativeFullscriptRecovery,
  readFullscriptOperatorFile } from './fullscript-native-custody';

/** Fixed member-account observations and shared bounded single-attempt Data API
 * transport. No profile, region, endpoint, database or custody-root overrides. */
export function createNativeFullscriptUpgradeDependencies(operatorFile:string,loadMigrations:()=>ClinicalCoreMigration[]):FullscriptUpgradeDependencies {
  let database:ClinicalCoreDatabase|undefined;
  const options={root:FULLSCRIPT_OPERATOR_SHARED_ROOT,operatorFile};
  return {
    readTarget:file=>readFullscriptOperatorFile(file),
    operatorSha256:()=>createHash('sha256').update(readFullscriptOperatorFile(operatorFile,16*1024*1024)).digest('hex'),
    observeCaller:()=>observeInventoryAws('caller'),observeFoundation:()=>observeInventoryAws('foundation'),loadMigrations,
    createDatabase:c=>database=createRdsDataAdministrativeDatabase({clusterArn:c.clusterArn,secretArn:c.secretArn,
      databaseName:c.qualificationDatabaseName,region:'us-east-2'},{purpose:'reviewed_production_schema_migration'},createBoundInventoryRdsClient(c)),
    withFence:work=>{if(!database)throw new FullscriptUpgradeError('custody_refused','database_unavailable');
      return withInventoryOperatorFence(database,work);},
    createCustody:(binding,baseline,fence)=>createNativeFullscriptCustody(options,binding,baseline,fence),
    openRecoveryCustody:(binding,fence)=>openNativeFullscriptRecovery(options,binding,fence),
  };
}
