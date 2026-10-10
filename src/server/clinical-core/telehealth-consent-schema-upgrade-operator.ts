if (typeof window !== 'undefined') throw Error('telehealth-consent-schema-upgrade-operator is server-only');
import type { ClinicalCoreMigration } from './migrations';
import { FullscriptUpgradeError } from './fullscript-schema-upgrade';
import { executeTelehealthConsentUpgradeCommand, type TelehealthConsentUpgradeBuild } from './telehealth-consent-upgrade-command';
import { createNativeTelehealthConsentUpgradeDependencies } from './telehealth-consent-upgrade-native-ports';
declare const __TELEHEALTH_CONSENT_UPGRADE_BUILD__:TelehealthConsentUpgradeBuild;
declare const __TELEHEALTH_CONSENT_UPGRADE_MIGRATIONS__:ClinicalCoreMigration[];
executeTelehealthConsentUpgradeCommand(process.argv.slice(2),__TELEHEALTH_CONSENT_UPGRADE_BUILD__,
  createNativeTelehealthConsentUpgradeDependencies(__filename,()=>__TELEHEALTH_CONSENT_UPGRADE_MIGRATIONS__))
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(error instanceof FullscriptUpgradeError?`${error.category}${error.stage?':'+error.stage:''}`:
      'telehealth_consent_upgrade_operator_failed_inspect_same_target');process.exitCode=1;
  });
