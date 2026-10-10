if(typeof window!=='undefined')throw Error('Fullscript deployment database inspection is server-only.');
import {BeginTransactionCommand,ExecuteStatementCommand,RollbackTransactionCommand} from '@aws-sdk/client-rds-data';
type Obj=Record<string,unknown>;
const fail=():never=>{throw Error('fullscript_deployment_database_refused');};
function check(v:unknown):asserts v{if(!v)fail();}
const object=(v:unknown):Obj=>{if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Obj;};
export const FULLSCRIPT_DEPLOYMENT_ROLES_SQL=`select jsonb_build_object(
 'databaseName',current_database(),'loginName',session_user,'workerRole',current_user,
 'readOnly',current_setting('transaction_read_only')='on',
 'loginSchemaCreate',coalesce((select jsonb_agg(nspname order by nspname) from pg_namespace
 where nspname not like 'pg_temp%' and has_schema_privilege(session_user,oid,'CREATE')),'[]'::jsonb),
 'workerSchemaCreate',coalesce((select jsonb_agg(nspname order by nspname) from pg_namespace
 where nspname not like 'pg_temp%' and has_schema_privilege(current_user,oid,'CREATE')),'[]'::jsonb),
 'reachableRoles',coalesce((select jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
 'createRole',rolcreaterole,'createDatabase',rolcreatedb,'replication',rolreplication,'bypassRls',rolbypassrls) order by rolname)
 from pg_roles where oid=(select oid from pg_roles where rolname=session_user) or pg_has_role(session_user,oid,'MEMBER')),'[]'::jsonb),
 'workerRoles',coalesce((select jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,
 'createRole',rolcreaterole,'createDatabase',rolcreatedb,'replication',rolreplication,'bypassRls',rolbypassrls) order by rolname)
 from pg_roles where oid=(select oid from pg_roles where rolname=current_user) or pg_has_role(current_user,oid,'MEMBER')),'[]'::jsonb)
 )::text as proof`;
// Check inherited, public and column grants as well as direct table grants.
// Ownership/superuser appears as effective privileges, never as an empty list.
export const FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL=`with privileges as (
 select n.nspname||'.'||c.relname||':'||p.name as privilege,
 (has_table_privilege(current_user,c.oid,p.name) or case when p.name in ('SELECT','INSERT','UPDATE','REFERENCES')
 then has_any_column_privilege(current_user,c.oid,p.name) else false end) as worker,
 (has_table_privilege(session_user,c.oid,p.name) or case when p.name in ('SELECT','INSERT','UPDATE','REFERENCES')
 then has_any_column_privilege(session_user,c.oid,p.name) else false end) as login
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(name)
 where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
 ) select jsonb_build_object('workerTablePrivileges',coalesce(jsonb_agg(privilege order by privilege) filter(where worker),'[]'::jsonb),
 'loginTablePrivileges',coalesce(jsonb_agg(privilege order by privilege) filter(where login),'[]'::jsonb),
 'ledger',fullscript_delivery.migration_ledger())::text as proof from privileges`;
function proof(response:Obj){
 check(Array.isArray(response.records)&&response.records.length===1&&Array.isArray(response.records[0])&&response.records[0].length===1);
 const value=object(response.records[0][0]);check(Object.keys(value).length===1&&typeof value.stringValue==='string'&&value.stringValue.length<=65536);
 return object(JSON.parse(String(value.stringValue)));
}
/** Same reviewed secret as the future worker, never an administrative fallback.
 * No DDL/DML, COMMIT, retries, or caller-supplied SQL. A successful report
 * requires an observed rollback; failure never claims transaction settlement. */
export function createFullscriptDeploymentDatabaseObserver(client:{send(command:unknown):Promise<Obj>}){
 return async(target:Obj):Promise<Obj>=>{
  let transactionId:string|undefined,result:Obj|undefined,failed=false;
  const common={resourceArn:String(target.clusterArn),secretArn:String(target.secretArn),database:String(target.databaseName)};
  try{
   check(target.databaseName==='clinical_core_qualification'&&typeof target.clusterArn==='string'
    &&/^arn:aws:rds:us-east-2:588966314750:cluster:[a-z0-9-]+$/.test(target.clusterArn)
    &&typeof target.secretArn==='string'&&/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9!/_+=.@-]+$/.test(target.secretArn));
   const begun=await client.send(new BeginTransactionCommand(common));check(typeof begun.transactionId==='string'&&begun.transactionId.length>0&&begun.transactionId.length<=192);
   transactionId=String(begun.transactionId);
   const query=(sql:string)=>client.send(new ExecuteStatementCommand({...common,transactionId,sql}));
   await query('set transaction read only');await query("set local statement_timeout = '5s'");
   const login=proof(await query(FULLSCRIPT_DEPLOYMENT_ROLES_SQL));
   check(login.readOnly===true&&login.databaseName===target.databaseName&&typeof login.loginName==='string'
    &&/^alp_fullscript_qualification_[a-z0-9_]{1,30}$/.test(login.loginName)&&Array.isArray(login.reachableRoles)
    &&Array.isArray(login.loginSchemaCreate)&&login.loginSchemaCreate.length===0);
   for(const raw of login.reachableRoles){const r=object(raw);check((r.name===login.loginName||r.name==='fullscript_draft_worker')
    &&r.superuser===false&&r.createRole===false&&r.createDatabase===false&&r.replication===false&&r.bypassRls===false);}
   await query('set local role fullscript_draft_worker');
   result={...proof(await query(FULLSCRIPT_DEPLOYMENT_ROLES_SQL)),...proof(await query(FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL))};
   check(result.loginName===login.loginName&&result.databaseName===target.databaseName&&result.workerRole==='fullscript_draft_worker'&&result.readOnly===true);
  }catch{failed=true;}
  // Even an error must attempt ONE rollback. It must not swallow a denied or
  // lost rollback response and then emit a successful prerequisite receipt.
  if(transactionId){try{const rolled=await client.send(new RollbackTransactionCommand({resourceArn:common.resourceArn,secretArn:common.secretArn,transactionId}));
   check(rolled.transactionStatus==='Transaction Rolled Back');
  }catch{failed=true;}}else failed=true;
  if(failed||!result)return fail();return {...result,rollbackConfirmed:true};
 };
}
