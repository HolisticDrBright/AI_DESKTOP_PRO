if (typeof window !== 'undefined') throw Error('telehealth-consent-upgrade-native-ports is server-only');
import { createHash } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import type { ClinicalCoreMigration } from './migrations';
import type { TelehealthConsentUpgradeDependencies } from './telehealth-consent-upgrade-command';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { createBoundInventoryRdsClient, observeInventoryAws } from './adopted-plan-inventory-native-ports';
import { withInventoryOperatorFence } from './adopted-plan-inventory-operator-fence';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import { TELEHEALTH_CONSENT_OPERATOR_SHARED_ROOT, createNativeTelehealthConsentCustody, openNativeTelehealthConsentRecovery,
  readTelehealthConsentOperatorFile } from './telehealth-consent-native-custody';

/** Fixed member-account observations and shared bounded single-attempt Data API
 * transport. No profile, region, endpoint, database or custody-root overrides. */
export function createNativeTelehealthConsentUpgradeDependencies(operatorFile:string,loadMigrations:()=>ClinicalCoreMigration[]):TelehealthConsentUpgradeDependencies {
  let database:ClinicalCoreDatabase|undefined;
  const options={root:TELEHEALTH_CONSENT_OPERATOR_SHARED_ROOT,operatorFile};
  return {
    readTarget:file=>readTelehealthConsentOperatorFile(file),
    operatorSha256:()=>createHash('sha256').update(readTelehealthConsentOperatorFile(operatorFile,16*1024*1024)).digest('hex'),
    observeCaller:()=>observeInventoryAws('caller'),observeFoundation:()=>observeInventoryAws('foundation'),loadMigrations,
    createDatabase:c=>database=createRdsDataAdministrativeDatabase({clusterArn:c.clusterArn,secretArn:c.secretArn,
      databaseName:c.qualificationDatabaseName,region:'us-east-2'},{purpose:'reviewed_production_schema_migration'},createBoundInventoryRdsClient(c)),
    withFence:work=>{if(!database)throw new FullscriptUpgradeError('custody_refused','database_unavailable');
      return withInventoryOperatorFence(database,work);},
    createCustody:(binding,baseline,fence)=>createNativeTelehealthConsentCustody(options,binding,baseline,fence),
    openRecoveryCustody:(binding,fence)=>openNativeTelehealthConsentRecovery(options,binding,fence),
  };
}
