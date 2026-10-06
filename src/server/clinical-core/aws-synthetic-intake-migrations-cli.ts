/** Narrow synthetic-only schema release: consult requests, intake and lifecycle. */
import {execFileSync} from 'node:child_process';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {loadClinicalCoreMigrations,splitPostgresStatements} from './migrations';

const account='588966314750',region='us-east-2',profile='ai-synthetic-staging';
const foundation='ai-clinical-core-synthetic-staging',databaseName='clinical_core';
const aliasVersion='20260902230000',aliasSource='20260821049700';
const specimenVersion='20260916080000';
const priorLatest='20260930120000';
const releases=[
 {version:'20260930130000',sha256:'adad3ed62e62f80e3f96eea70e39acfbd75d18fe3dd6e78f99a7cfa15a8ab167'},
 {version:'20260930140000',sha256:'4cdb7042fc2fd7d83911ad024e9f9f2b07075441ea138f9f447fbfded887b64e'},
 {version:'20260930150000',sha256:'3dae779f3f84db058142c3d77dd6b5681c68113760d20eb42b50767af3f8fb78'},
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
 if(prior.length!==38)throw Error('reviewed_history_changed');
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
  phiAllowed:false,reviewedPrior:38,alreadyApplied,selected:releases}));
}
main().catch(error=>{
 const code=error instanceof Error&&[
  'command_refused','synthetic_account_required','synthetic_target_refused','migration_artifact_changed',
  'reviewed_history_changed','post_apply_ledger_mismatch','rehearsal_persisted','aws_read_failed',
 ].includes(error.message)?error.message:'migration_failed';
 console.error(JSON.stringify({ok:false,error:code}));process.exitCode=1;
});
