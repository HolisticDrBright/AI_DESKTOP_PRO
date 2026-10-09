/** Narrow synthetic-only release after the source-bound program migration. */
import {execFileSync} from 'node:child_process';
import {createRdsDataAdministrativeDatabase} from './rds-data-database';
import {loadClinicalCoreMigrations,splitPostgresStatements} from './migrations';

const account='588966314750',region='us-east-2',profile='ai-synthetic-staging';
const foundation='ai-clinical-core-synthetic-staging',databaseName='clinical_core';
const aliasVersion='20260902230000',aliasSource='20260821049700';
const priorLatest='20260929120000';
const releases=[
 {version:'20260930100000',sha256:'d6ca115e4ee3093859569e7a18f51867fb2204fb550795bc29a8e76ddaa486be'},
 {version:'20260930110000',sha256:'f30ae4449b5ae2f5269d804bb69da6f942e0d2e3686c932d0cd1a7b7c7e26496'},
 {version:'20260930120000',sha256:'80e2ce0e2c73a8985721c42bafe88ea5cf7a55c039c34aca2f57bb1603b72951'},
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
 if(!alias)throw Error('reviewed_alias_missing');
 const prior=migrations.filter(m=>m.version<=priorLatest&&m.version!=='20260916080000')
  .map(({version,name,sha256})=>({version,name,sha256}));
 // The specimen-context migration was applied after the historical 33-row
 // ledger, and the live workforce-directory alias predates both releases.
 const specimen=migrations.find(m=>m.version==='20260916080000');
 if(!specimen||specimen.sha256!=='9b5cfe0a73f201fec488e4259731f8f3475af2a98ba1f68ad7ae2edc76350020')
  throw Error('reviewed_history_changed');
 prior.push({version:specimen.version,name:specimen.name,sha256:specimen.sha256});
 prior.push({version:aliasVersion,name:alias.name,sha256:alias.sha256});
 prior.sort((a,b)=>a.version.localeCompare(b.version));
 if(prior.length!==35)throw Error('reviewed_history_changed');
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
  phiAllowed:false,reviewedPrior:35,alreadyApplied,selected:releases}));
}
main().catch(error=>{
 const code=error instanceof Error&&[
  'command_refused','synthetic_account_required','synthetic_target_refused','migration_artifact_changed',
  'reviewed_alias_missing','reviewed_history_changed','post_apply_ledger_mismatch','rehearsal_persisted','aws_read_failed',
 ].includes(error.message)?error.message:'migration_failed';
 console.error(JSON.stringify({ok:false,error:code}));process.exitCode=1;
});
