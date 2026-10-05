/** Narrow synthetic-only release: lab specimen context followed by program assignments. */
import { execFileSync } from 'node:child_process';
import { createRdsDataAdministrativeDatabase } from './rds-data-database';
import { loadClinicalCoreMigrations, splitPostgresStatements } from './migrations';

const account='588966314750', region='us-east-2', profile='ai-synthetic-staging';
const foundation='ai-clinical-core-synthetic-staging', databaseName='clinical_core';
const specimenVersion='20260916080000', programVersion='20260929120000';
const settlementVersion='20260929110000', aliasVersion='20260902230000', aliasSource='20260821049700';
const pinned:Record<string,string>={
  [specimenVersion]:'9b5cfe0a73f201fec488e4259731f8f3475af2a98ba1f68ad7ae2edc76350020',
  [programVersion]:'8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8',
};
type LedgerRow={version:string;name:string;sha256:string};
function aws<T>(service:string,operation:string,...args:string[]):T {
  try{return JSON.parse(execFileSync('aws',[service,operation,...args,'--profile',profile,'--region',region,'--output','json'],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true})) as T;}
  catch{throw new Error('aws_read_failed');}
}
function same(a:LedgerRow[],b:LedgerRow[]){return JSON.stringify(a)===JSON.stringify(b);}

async function main(){
  const mode=process.argv[2];
  if(!['inspect','rehearse','apply'].includes(mode)||process.argv.length!==(mode==='inspect'?3:4)
    ||(mode!=='inspect'&&process.argv[3]!=='--confirm-synthetic-only'))throw new Error('command_refused');
  if(aws<{Account:string}>('sts','get-caller-identity').Account!==account)throw new Error('synthetic_account_required');
  const stack=aws<{Stacks:Array<{StackStatus:string;Outputs:Array<{OutputKey:string;OutputValue:string}>}>}>('cloudformation','describe-stacks','--stack-name',foundation).Stacks?.[0];
  const out=Object.fromEntries((stack?.Outputs??[]).map((x:{OutputKey:string;OutputValue:string})=>[x.OutputKey,x.OutputValue]));
  if(!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack?.StackStatus)||out.PhiAllowed!=='false'
    ||out.DataClassification!=='synthetic_only'||out.Environment!=='synthetic-staging'
    ||out.DatabaseName!==databaseName||out.ClinicalApiId!=='wxv734oi12'
    ||!out.DatabaseClusterArn?.includes(`:${account}:cluster:`)||!out.DatabaseSecretArn?.includes(`:${account}:secret:`))
    throw new Error('synthetic_target_refused');
  const migrations=loadClinicalCoreMigrations();
  const selected=[specimenVersion,programVersion].map(version=>{
    const found=migrations.find(m=>m.version===version);
    if(!found||found.sha256!==pinned[version])throw new Error('migration_artifact_changed');
    return found;
  });
  const alias=migrations.find(m=>m.version===aliasSource);
  if(!alias)throw new Error('reviewed_alias_missing');
  const prior=migrations.filter(m=>m.version<=settlementVersion&&m.version!==specimenVersion)
    .map(({version,name,sha256})=>({version,name,sha256}));
  prior.push({version:aliasVersion,name:alias.name,sha256:alias.sha256});
  prior.sort((a,b)=>a.version.localeCompare(b.version));
  if(prior.length!==33)throw new Error('reviewed_history_changed');
  process.env.AWS_PROFILE=profile;
  const db=createRdsDataAdministrativeDatabase({clusterArn:out.DatabaseClusterArn,secretArn:out.DatabaseSecretArn,
    databaseName,region},{purpose:'reviewed_synthetic_migration'});
  const target=[...prior,...selected.map(({version,name,sha256})=>({version,name,sha256}))].sort((a,b)=>a.version.localeCompare(b.version));
  let observed:{alreadyApplied:boolean}|undefined;
  try{observed=await db.transaction(async tx=>{
    await tx.query("select pg_advisory_xact_lock(hashtext('ai-desktop-pro:clinical-core-migrations'))");
    const rows=(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
    if(mode==='inspect'){
      if(!same(rows,prior)&&!same(rows,target))throw new Error('reviewed_history_changed');
      return {alreadyApplied:same(rows,target)};
    }
    if(!same(rows,prior))throw new Error('reviewed_history_changed');
    for(const migration of selected){
      for(const statement of splitPostgresStatements(migration.sql))await tx.query(statement);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',
        [migration.version,migration.name,migration.sha256]);
    }
    const after=(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows;
    if(!same(after,target))throw new Error('post_apply_ledger_mismatch');
    if(mode==='rehearse')throw new Error('rollback_only');
    return {alreadyApplied:false};
  });}catch(error){if(mode!=='rehearse'||!(error instanceof Error)||error.message!=='rollback_only')throw error;}
  if(mode==='rehearse'){
    const after=await db.transaction(async tx=>(await tx.query<LedgerRow>('select version,name,sha256 from clinical_core.schema_migrations order by version')).rows);
    if(!same(after,prior))throw new Error('rehearsal_persisted');
  }
  console.log(JSON.stringify({ok:true,execution:'synthetic-staging',mode,account,database:databaseName,
    phiAllowed:false,alreadyApplied:observed?.alreadyApplied??false,reviewedPrior:33,
    selected:selected.map(({version,sha256})=>({version,sha256}))}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,error:error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'migration_failed'}));process.exitCode=1;});
