if (typeof window !== 'undefined') throw Error('fullscript-schema-upgrade-operator is server-only');
import type { ClinicalCoreMigration } from './migrations';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import { executeFullscriptUpgradeCommand, type FullscriptUpgradeBuild } from './fullscript-upgrade-command';
import { createNativeFullscriptUpgradeDependencies } from './fullscript-upgrade-native-ports';
declare const __FULLSCRIPT_UPGRADE_BUILD__:FullscriptUpgradeBuild;
declare const __FULLSCRIPT_UPGRADE_MIGRATIONS__:ClinicalCoreMigration[];
executeFullscriptUpgradeCommand(process.argv.slice(2),__FULLSCRIPT_UPGRADE_BUILD__,
  createNativeFullscriptUpgradeDependencies(__filename,()=>__FULLSCRIPT_UPGRADE_MIGRATIONS__))
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(error instanceof FullscriptUpgradeError?`${error.category}${error.stage?':'+error.stage:''}`:
      'fullscript_upgrade_operator_failed_inspect_same_target');process.exitCode=1;
  });
