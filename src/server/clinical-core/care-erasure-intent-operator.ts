if (typeof window !== 'undefined') throw new Error('care-erasure-intent-operator is server-only');
import {execFileSync} from 'node:child_process';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {RDSDataClient} from '@aws-sdk/client-rds-data';
import type {ClinicalCoreMigration} from './migrations';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {CARE_ERASURE_AWS,CareErasureUpgradeError} from './care-erasure-schema-upgrade';
import {CareErasureIntentUpgradeError} from './care-erasure-intent-upgrade';
import {executeCareErasureIntentCommand,CareErasureIntentCommandError} from './care-erasure-intent-command';
declare const __CARE_INTENT_BUILD__:{sourceCommit:string;clean:boolean};
declare const __CARE_INTENT_MIGRATIONS__:ClinicalCoreMigration[];
declare const __CARE_INTENT_REFERENCE__:ClinicalCoreMigration[];
declare const __CARE_INTENT_OVERLAY__:ClinicalCoreMigration;
const {profile,region,foundation}=CARE_ERASURE_AWS;
const aws=(args:string[])=>JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',region,'--output','json'],
 {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],windowsHide:true}));
executeCareErasureIntentCommand(process.argv.slice(2),__CARE_INTENT_BUILD__,{
 observeCaller:()=>aws(['sts','get-caller-identity']),
 observeFoundation:()=>aws(['cloudformation','describe-stacks','--stack-name',foundation]),
 loadMigrations:()=>__CARE_INTENT_MIGRATIONS__,loadReference:()=>__CARE_INTENT_REFERENCE__,loadOverlay:()=>__CARE_INTENT_OVERLAY__,
 createDatabase:c=>createRdsDataAdministrativeDatabase({clusterArn:c.clusterArn,secretArn:c.secretArn,databaseName:c.databaseName,region},
  {purpose:'reviewed_synthetic_migration'},new RDSDataClient({region,credentials:fromIni({profile}),maxAttempts:1})),
}).then(r=>console.log(JSON.stringify(r))).catch(error=>{
 const known=error instanceof CareErasureIntentCommandError||error instanceof CareErasureIntentUpgradeError||error instanceof CareErasureUpgradeError;
 console.error(known?`${error.category}${'stage' in error&&error.stage?':'+error.stage:''}`:'care_erasure_intent_operator_failed');
 process.exitCode=1;
});
