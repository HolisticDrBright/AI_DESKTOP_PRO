if (typeof window !== 'undefined') throw Error('telehealth-consent-copy-native-ports is server-only');
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import type {ClinicalCoreDatabase} from './database';
import type {ClinicalCoreMigration} from './migrations';
import type {TelehealthCopyCommandDependencies} from './telehealth-consent-copy-command';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {createBoundInventoryRdsClient,observeInventoryAws} from './adopted-plan-inventory-native-ports';
import {withInventoryOperatorFence} from './adopted-plan-inventory-operator-fence';
import {FullscriptUpgradeError} from './fullscript-schema-upgrade';
import {TELEHEALTH_COPY_OPERATOR_SHARED_ROOT,createNativeTelehealthCopyCustody,openNativeTelehealthCopyRecovery,
  readTelehealthCopyOperatorFile} from './telehealth-consent-copy-native-custody';

/** No profile, region, endpoint, database or custody-root override. The command
 * separately admits the exact absolute copy/target paths before any file/AWS
 * observation. Administrative recovery never restores patient authority. */
export function createNativeTelehealthCopyDependencies(operatorFile:string,copyFile:string,
  loadMigrations:()=>ClinicalCoreMigration[]):TelehealthCopyCommandDependencies {
  let database:ClinicalCoreDatabase|undefined;
  const options={root:TELEHEALTH_COPY_OPERATOR_SHARED_ROOT,operatorFile,copyFile};
  return {
    readTarget:file=>readTelehealthCopyOperatorFile(file),
    readCopy:file=>{if(resolve(file)!==resolve(copyFile))throw new FullscriptUpgradeError('custody_refused','copy_path');
      return readTelehealthCopyOperatorFile(file,131072);},
    operatorSha256:()=>createHash('sha256').update(readTelehealthCopyOperatorFile(operatorFile,16*1024*1024)).digest('hex'),
    observeCaller:()=>observeInventoryAws('caller'),observeFoundation:()=>observeInventoryAws('foundation'),loadMigrations,
    createDatabase:c=>database=createRdsDataAdministrativeDatabase({clusterArn:c.clusterArn,secretArn:c.secretArn,
      databaseName:c.qualificationDatabaseName,region:'us-east-2'},{purpose:'reviewed_consent_copy_registration'},createBoundInventoryRdsClient(c)),
    withFence:work=>{if(!database)throw new FullscriptUpgradeError('custody_refused','database_unavailable');
      return withInventoryOperatorFence(database,work);},
    createCustody:(binding,baseline,fence)=>createNativeTelehealthCopyCustody(options,binding,baseline,fence),
    openRecoveryCustody:(binding,fence)=>openNativeTelehealthCopyRecovery(options,binding,fence),
  };
}
