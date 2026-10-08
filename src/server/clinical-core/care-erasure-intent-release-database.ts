if(typeof window!=='undefined')throw new Error('care-erasure-intent-release-database is server-only');
import {execFileSync} from 'node:child_process';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {RDSDataClient} from '@aws-sdk/client-rds-data';
import type {ClinicalCoreMigration} from './migrations';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {CARE_ERASURE_AWS,careErasureUpgradeFromAws} from './care-erasure-schema-upgrade';
import {careErasureIntentMapping,runCareErasureIntentUpgrade,CareErasureIntentUpgradeError} from './care-erasure-intent-upgrade';
import {createCareErasureOperatorClient} from './care-erasure-operator-client';
declare const __CARE_INTENT_RELEASE_BUILD__:{sourceCommit:string;clean:boolean};
declare const __CARE_INTENT_RELEASE_MIGRATIONS__:ClinicalCoreMigration[];
declare const __CARE_INTENT_RELEASE_REFERENCE__:ClinicalCoreMigration[];
declare const __CARE_INTENT_RELEASE_OVERLAY__:ClinicalCoreMigration;
/** Embedded library port only. The public inspection CLI still refuses upgrade.
 * The fixed-target live runner must call this within the same recovery custody;
 * it is not a report, approval, activation or command-line input surface. */
export async function runCareIntentReleaseDatabase(command:'inspect'|'rehearse'|'upgrade',sourceCommit:string){
 const build={...__CARE_INTENT_RELEASE_BUILD__};
 if(!['inspect','rehearse','upgrade'].includes(command)||build.clean!==true||build.sourceCommit!==sourceCommit
  ||!/^[a-f0-9]{40}$/.test(sourceCommit))throw new CareErasureIntentUpgradeError('boundary_refused');
 const a=CARE_ERASURE_AWS;
 const aws=(args:string[])=>JSON.parse(execFileSync('aws',[...args,'--profile',a.profile,'--region',a.region,'--output','json'],
  {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']}));
 const observe=()=>careErasureUpgradeFromAws(aws(['sts','get-caller-identity']),
  aws(['cloudformation','describe-stacks','--stack-name',a.foundation]));
 const configuration=observe(),m=__CARE_INTENT_RELEASE_MIGRATIONS__.map(x=>({...x})),
  reference=__CARE_INTENT_RELEASE_REFERENCE__.map(x=>({...x})),overlay={...__CARE_INTENT_RELEASE_OVERLAY__};
 careErasureIntentMapping(m,reference,overlay,configuration);
 const client=new RDSDataClient({region:a.region,credentials:fromIni({profile:a.profile}),maxAttempts:1,
  requestHandler:{httpsAgent:{keepAlive:false,maxSockets:1},connectionTimeout:10000,requestTimeout:30000}});
 const transport=createCareErasureOperatorClient(client);
 try{
  const database=createRdsDataAdministrativeDatabase(configuration,{purpose:'reviewed_synthetic_migration'},transport.client);
  const result=await runCareErasureIntentUpgrade(database,m,reference,overlay,configuration,command);
  if(JSON.stringify(observe())!==JSON.stringify(configuration))throw new CareErasureIntentUpgradeError('boundary_refused');
  // This port reports its database scope, not the containing release runner's
  // API work. Match the inspection command's actual database witness shape.
  return {...result,operatorSource:build,awsAccountId:a.account,foundation:a.foundation,
   rollbackReadback:command==='rehearse',lastingUpgradeAvailable:false,apiDeploymentPerformed:false,
   recoveryDrillPerformed:false,acceptance:false,phiActivation:false};
 }catch(error){
  // Never derive unknown-commit authority from an error message or a caller
  // flag. The SDK wrapper observes the phase without storing SQL or parameters.
  if(command==='upgrade'&&error instanceof CareErasureIntentUpgradeError&&error.category==='upgrade_failed'
   &&transport.failure()?.startsWith('commit_'))Object.assign(error,{commitOutcomeUnknown:true});
  throw error;
 }finally{client.destroy();}
}
