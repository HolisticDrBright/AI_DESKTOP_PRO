if (typeof window !== 'undefined') throw Error('telehealth-consent-copy-operator is server-only');
import type {ClinicalCoreMigration} from './migrations';
import {FullscriptUpgradeError} from './fullscript-schema-upgrade';
import {CareConsentCopyError} from './care-consent-copy-registration';
import {CareConnectionsUpgradeError} from './care-connections-schema-upgrade';
import {executeTelehealthCopyCommand,type TelehealthCopyBuild} from './telehealth-consent-copy-command';
import {createNativeTelehealthCopyDependencies} from './telehealth-consent-copy-native-ports';

declare const __TELEHEALTH_COPY_BUILD__:TelehealthCopyBuild;
declare const __TELEHEALTH_COPY_MIGRATIONS__:ClinicalCoreMigration[];
const args=process.argv.slice(2);
executeTelehealthCopyCommand(args,__TELEHEALTH_COPY_BUILD__,
  createNativeTelehealthCopyDependencies(__filename,args[6]??'',()=>__TELEHEALTH_COPY_MIGRATIONS__))
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(error instanceof FullscriptUpgradeError?`${error.category}${error.stage?':'+error.stage:''}`:
      error instanceof CareConsentCopyError||error instanceof CareConnectionsUpgradeError?error.category:
        'telehealth_copy_operator_failed_inspect_same_target');process.exitCode=1;
  });
