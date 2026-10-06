/** Release only the five remaining reviewed synthetic-staging clinical-core migrations. */
import {execFileSync} from 'node:child_process';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {loadClinicalCoreMigrations,splitPostgresStatements} from './migrations';

const account='588966314750',region='us-east-2',profile='ai-synthetic-staging';
const foundation='ai-clinical-core-synthetic-staging',databaseName='clinical_core';
const aliasVersion='20260902230000',aliasSource='20260821049700';
const specimenVersion='20260916080000';
const priorLatest='20260930150000';
const releases=[
 {version:'20260930160000',sha256:'bca159d3bb7b9749f5fb4b975e6c91a23450cbb83ebabaee112c8582f9cabd73'},
 {version:'20260930170000',sha256:'23cdfcce44d529b204493d7dbfb01ac41c15081bfed7e53cf1befb771844854f'},
 {version:'20260930180000',sha256:'5afa197c2ec1c973e19ffe5b3cfc85924787785ae20bfbb5f237d1b0dd6cf62b'},
 {version:'20260930190000',sha256:'e45fa0fc37452e3b94ce0b1ff37199f3ede8532714380af64b2eda69d835586e'},
 {version:'20260930200000',sha256:'727c6b212cde6441dafa4e8b393d1ae9dbd7caaec02af519b32884ba40ec56fe'},
] as const;
type LedgerRow={version:string;name:string;sha256:string};
function aws<T>(service:string,operation:string,...args:string[]):T{
 try{return JSON.parse(execFileSync('aws',[service,operation,...args,'--profile',profile,'--region',region,'--output','json'],
  {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true})) as T;}
 catch{throw Error('aws_read_failed');}
}
function same(a:LedgerRow[],b:LedgerRow[]){return JSON.stringify(a)===JSON.stringify(b);}

async function main(){
 const mode=process.argv[2];
 if(!['inspect','rehearse','apply'].includes(mode)||process.argv.length!==(mode==='inspect'?3:4)
   ||(mode!=='inspect'&&process.argv[3]!=='--confirm-synthetic-only'))throw Error('command_refused');
 if(aws<{Account:string}>('sts','get-caller-identity').Account!==account)throw Error('synthetic_account_required');
 const stack=aws<{Stacks:Array<{StackStatus:string;Outputs:Array<{OutputKey:string;OutputValue:string}>}>}>('cloudformation','describe-stacks','--stack-name',foundation).Stacks?.[0];
 const out=Object.fromEntries((stack?.Outputs??[]).map(x=>[x.OutputKey,x.OutputValue]));
 if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack?.StackStatus)||out.PhiAllowed!=='false'
   ||out.DataClassification!=='synthetic_only'||out.Environment!=='synthetic-staging'
   ||out.DatabaseName!==databaseName||out.ClinicalApiId!=='wxv734oi12'
   ||!out.DatabaseClusterArn?.includes(`:${account}:cluster:`)||!out.DatabaseSecretArn?.includes(`:${account}:secret:`))
   throw Error('synthetic_target_refused');
 const migrations=loadClinicalCoreMigrations();
 const selected=releases.map(release=>{
  const found=migrations.find(m=>m.version===release.version);
  if(!found||found.sha256!==release.sha256)throw Error('migration_artifact_changed');
  return found;
 });
 const alias=migrations.find(m=>m.version===aliasSource);
 const specimen=migrations.find(m=>m.version===specimenVersion);
 if(!alias||!specimen||specimen.sha256!=='9b5cfe0a73f201fec488e4259731f8f3475af2a98ba1f68ad7ae2edc76350020')
  throw Error('reviewed_history_changed');
 const prior=migrations.filter(m=>m.version<=priorLatest&&m.version!==specimenVersion)
  .map(({version,name,sha256})=>({version,name,sha256}));
 prior.push({version:specimen.version,name:specimen.name,sha256:specimen.sha256});
 prior.push({version:aliasVersion,name:alias.name,sha256:alias.sha256});
 prior.sort((a,b)=>a.version.localeCompare(b.version));
 if(prior.length!==41)throw Error('reviewed_history_changed');
 const target=[...prior,...selected.map(({version,name,sha256})=>({version,name,sha256}))]
  .sort((a,b)=>a.version.localeCompare(b.version));
 process.env.AWS_PROFILE=profile;
 const db=createRdsDataAdministrativeDatabase({clusterArn:out.DatabaseClusterArn,secretArn:out.DatabaseSecretArn,
  databaseName,region},{purpose:'reviewed_synthetic_migration'});
 let alreadyApplied=false;
 try{await db.transaction(async tx=>{
  await tx.query("select pg_advisory_xact_lock(hashtext('ai-desktop-pro:clinical-core-migrations'))");
  const rows=(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
  if(mode==='inspect'){
   if(!same(rows,prior)&&!same(rows,target))throw Error('reviewed_history_changed');
   alreadyApplied=same(rows,target);return;
  }
  if(!same(rows,prior))throw Error('reviewed_history_changed');
  for(const migration of selected){
   for(const statement of splitPostgresStatements(migration.sql))await tx.query(statement);
   await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
    [migration.version,migration.name,migration.sha256]);
  }
  const after=(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
  if(!same(after,target))throw Error('post_apply_ledger_mismatch');
  if(mode==='rehearse')throw Error('rollback_only');
 });}catch(error){if(mode!=='rehearse'||!(error instanceof Error)||error.message!=='rollback_only')throw error;}
 if(mode==='rehearse'){
  const after=await db.transaction(async tx=>(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows);
  if(!same(after,prior))throw Error('rehearsal_persisted');
 }
 console.log(JSON.stringify({ok:true,execution:'synthetic-staging',mode,account,database:databaseName,
  phiAllowed:false,reviewedPrior:41,alreadyApplied,selected:releases}));
}
main().catch(error=>{
 const code=error instanceof Error&&[
  'command_refused','synthetic_account_required','synthetic_target_refused','migration_artifact_changed',
  'reviewed_history_changed','post_apply_ledger_mismatch','rehearsal_persisted','aws_read_failed',
 ].includes(error.message)?error.message:'migration_failed';
 console.error(JSON.stringify({ok:false,error:code}));process.exitCode=1;
});
