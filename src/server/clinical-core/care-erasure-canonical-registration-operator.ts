if(typeof window!=='undefined')throw Error('care-erasure-canonical-registration-operator is server-only');
import {execFileSync} from 'node:child_process';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {RDSDataClient} from '@aws-sdk/client-rds-data';
import type {ClinicalCoreMigration} from './migrations';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {CARE_ERASURE_AWS,careErasureUpgradeFromAws} from './care-erasure-schema-upgrade';
import {createCareErasureOperatorClient} from './care-erasure-operator-client';
import {inspectCanonicalCareErasure} from './care-erasure-canonical-registration';
declare const __CARE_CANONICAL_BUILD__:{sourceCommit:string;clean:boolean};
declare const __CARE_CANONICAL_MIGRATIONS__:ClinicalCoreMigration[];
declare const __CARE_CANONICAL_REFERENCE__:ClinicalCoreMigration[];
const a=CARE_ERASURE_AWS;
const aws=(args:string[])=>{
 if(Object.entries(process.env).some(([key,value])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(key)&&value))
  throw Error('care_canonical_registration_boundary_refused');
 return JSON.parse(execFileSync('aws',[...args,'--profile',a.profile,'--region',a.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}}));
};
let client:RDSDataClient|undefined;
let transport:ReturnType<typeof createCareErasureOperatorClient>|undefined;
async function main(){
 const build={...__CARE_CANONICAL_BUILD__};
 if(process.argv.length!==3||process.argv[2]!=='inspect'||build.clean!==true||!/^[a-f0-9]{40}$/.test(build.sourceCommit))
  throw Error('care_canonical_registration_boundary_refused');
 const observe=()=>careErasureUpgradeFromAws(aws(['sts','get-caller-identity']),
  aws(['cloudformation','describe-stacks','--stack-name',a.foundation]));
 const configuration=observe(),m=__CARE_CANONICAL_MIGRATIONS__,reference=__CARE_CANONICAL_REFERENCE__;
 client=new RDSDataClient({region:a.region,credentials:fromIni({profile:a.profile}),maxAttempts:1,
  requestHandler:{httpsAgent:{keepAlive:false,maxSockets:1},connectionTimeout:10000,requestTimeout:30000}});
 transport=createCareErasureOperatorClient(client);
 const db=createRdsDataAdministrativeDatabase(configuration,{purpose:'reviewed_synthetic_migration'},transport.client);
 const before=await inspectCanonicalCareErasure(db,m,reference,configuration);
 const after=await inspectCanonicalCareErasure(db,m,reference,configuration);
 if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(observe())!==JSON.stringify(configuration))
  throw Error('care_canonical_registration_observation_changed');
 return {...after,operatorSource:build,awsAccountId:a.account,foundation:a.foundation,observedAt:new Date().toISOString(),
  repeatedReadbackVerified:true,reportIsNotAuthority:true};
}
main().then(r=>{console.log(JSON.stringify(r));}).catch(error=>{
 const code=error&&typeof error==='object'&&'category' in error?String(error.category):error instanceof Error?error.message:'';
 console.error(/^(?:care_canonical_registration_[a-z_]+|artifact_refused|history_refused|boundary_refused|inventory_refused|policy_refused|data_changed|schema_changed|verification_failed|upgrade_failed)$/.test(code)
  ?code+(transport?.failure()?':'+transport.failure():''):'care_canonical_registration_failed');process.exitCode=1;
}).finally(()=>client?.destroy());
