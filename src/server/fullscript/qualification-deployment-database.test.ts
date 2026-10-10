import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {BeginTransactionCommand,ExecuteStatementCommand,RollbackTransactionCommand} from '@aws-sdk/client-rds-data';
import {createFullscriptDeploymentDatabaseObserver,FULLSCRIPT_DEPLOYMENT_ROLES_SQL,FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL} from './qualification-deployment-database';
type Obj=Record<string,unknown>;
const target={databaseName:'clinical_core_qualification',clusterArn:'arn:aws:rds:us-east-2:588966314750:cluster:fictional',secretArn:'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-db'};
const worker='fullscript_draft_worker',login='alp_fullscript_qualification_fictional';
const role=(name:string)=>({name,superuser:false,createRole:false,createDatabase:false,replication:false,bypassRls:false});
const roles=(asWorker=false)=>({databaseName:target.databaseName,loginName:login,workerRole:asWorker?worker:login,readOnly:true,loginSchemaCreate:[],workerSchemaCreate:[],
 reachableRoles:[role(login),role(worker)],workerRoles:asWorker?[role(worker)]:[role(login),role(worker)]});
const response=(v:unknown)=>({records:[[{stringValue:JSON.stringify(v)}]]});
function fixture(){let workerSelected=false;
 const send=vi.fn(async(command:unknown):Promise<Obj>=>{
  if(command instanceof BeginTransactionCommand)return {transactionId:'fictional-transaction'};
  if(command instanceof RollbackTransactionCommand)return {transactionStatus:'Transaction Rolled Back'};
  if(command instanceof ExecuteStatementCommand){
   if(command.input.sql==='set local role fullscript_draft_worker')workerSelected=true;
   if(command.input.sql===FULLSCRIPT_DEPLOYMENT_ROLES_SQL)return response(roles(workerSelected));
   if(command.input.sql===FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL)return response({workerTablePrivileges:['fullscript_delivery.draft_intents:SELECT'],loginTablePrivileges:[],ledger:[]});
   return {};
  }throw Error('unrouted fictional command');
 });return {send,observe:createFullscriptDeploymentDatabaseObserver({send})};
}
it('uses the same target, read-only transaction, fixed SQL and confirmed rollback without a commit',async()=>{
 const {send,observe}=fixture();expect(await observe(target)).toMatchObject({readOnly:true,workerRole:worker,rollbackConfirmed:true});
 const commands=send.mock.calls.map(([c])=>c);expect(commands[0]).toBeInstanceOf(BeginTransactionCommand);
 expect(commands.at(-1)).toBeInstanceOf(RollbackTransactionCommand);
 const sql=commands.filter(c=>c instanceof ExecuteStatementCommand).map(c=>c.input.sql);
 expect(sql).toEqual(['set transaction read only',"set local statement_timeout = '5s'",FULLSCRIPT_DEPLOYMENT_ROLES_SQL,
  'set local role fullscript_draft_worker',FULLSCRIPT_DEPLOYMENT_ROLES_SQL,FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL]);
 for(const c of commands){expect((c as {input:Obj}).input).toMatchObject({resourceArn:target.clusterArn,secretArn:target.secretArn});}
 expect(commands.every(c=>c instanceof BeginTransactionCommand||c instanceof ExecuteStatementCommand||c instanceof RollbackTransactionCommand)).toBe(true);
});
it.each(['wrong-db','wrong-account','wrong-secret'])('refuses %s before beginning',async kind=>{
 const {send,observe}=fixture(),t={...target};
 if(kind==='wrong-db')t.databaseName='clinical_core';if(kind==='wrong-account')t.clusterArn=t.clusterArn.replace('588966314750','173535830222');
 if(kind==='wrong-secret')t.secretArn='invalid';await expect(observe(t)).rejects.toThrow();expect(send).not.toHaveBeenCalled();
});
it.each(['superuser','createRole','createDatabase','replication','bypassRls','foreign-role','postgres','not-readonly'])('refuses unsafe login %s before role selection and rolls back once',async kind=>{
 const {send,observe}=fixture(),original=send.getMockImplementation()!;
 send.mockImplementation(async c=>{
  if(c instanceof ExecuteStatementCommand&&c.input.sql===FULLSCRIPT_DEPLOYMENT_ROLES_SQL){const r=roles();
   if(['superuser','createRole','createDatabase','replication','bypassRls'].includes(kind))(r.reachableRoles[0] as Obj)[kind]=true;
   if(kind==='foreign-role')r.reachableRoles.push(role('clinical_core_api'));if(kind==='postgres')r.loginName='postgres';
   if(kind==='not-readonly')r.readOnly=false;return response(r);
  }return original(c);
 });await expect(observe(target)).rejects.toThrow(/^fullscript_deployment_database_refused$/);
 expect(send.mock.calls.some(([c])=>c instanceof ExecuteStatementCommand&&c.input.sql==='set local role fullscript_draft_worker')).toBe(false);
 expect(send.mock.calls.filter(([c])=>c instanceof RollbackTransactionCommand)).toHaveLength(1);
});
it.each(['lost','denied','malformed','wrong-status'])('never certifies a %s rollback',async kind=>{
 const {send,observe}=fixture(),original=send.getMockImplementation()!;
 send.mockImplementation(async c=>{if(c instanceof RollbackTransactionCommand){if(kind==='lost'||kind==='denied')throw Error('SECRET rollback denied');
  return kind==='malformed'?{}:{transactionStatus:'Transaction Committed'};}return original(c);});
 await expect(observe(target)).rejects.toThrow(/^fullscript_deployment_database_refused$/);
 expect(send.mock.calls.filter(([c])=>c instanceof RollbackTransactionCommand)).toHaveLength(1);
});
it.each(['duplicate-row','extra-column','bad-json','large-json','query-error'])('refuses %s and does not retry SQL',async kind=>{
 const {send,observe}=fixture(),original=send.getMockImplementation()!;
 send.mockImplementation(async c=>{if(c instanceof ExecuteStatementCommand&&c.input.sql===FULLSCRIPT_DEPLOYMENT_ROLES_SQL){
  if(kind==='query-error')throw Error('SECRET SQL');if(kind==='duplicate-row')return {records:[[{stringValue:'{}'}],[{stringValue:'{}'}]]};
  if(kind==='extra-column')return {records:[[{stringValue:'{}'},{stringValue:'{}'}]]};
  return {records:[[{stringValue:kind==='bad-json'?'not-json':' '.repeat(65537)}]]};
 }return original(c);});await expect(observe(target)).rejects.toThrow();
 expect(send.mock.calls.filter(([c])=>c instanceof ExecuteStatementCommand&&c.input.sql===FULLSCRIPT_DEPLOYMENT_ROLES_SQL)).toHaveLength(1);
});
let db:PGlite;
const schema=`create role ${worker} nologin;create role ${login} login;grant ${worker} to ${login};
 create schema fullscript_delivery;create table fullscript_delivery.draft_intents(id text);
 create schema clinical_core;create table clinical_core.private_records(id text);
 grant usage on schema fullscript_delivery,clinical_core to ${worker};
 grant select,insert,update on fullscript_delivery.draft_intents to ${worker};
 create function fullscript_delivery.migration_ledger() returns jsonb language sql security definer set search_path=pg_catalog
 as $$select '[]'::jsonb$$;revoke all on function fullscript_delivery.migration_ledger() from public;
 grant execute on function fullscript_delivery.migration_ledger() to ${worker};`;
beforeAll(async()=>{db=new PGlite();await db.exec(schema);});
afterAll(async()=>{await db?.close();});
it('executes the fixed privilege SQL against PostgreSQL roles and detects a public column grant',async()=>{
 // Real SQL, fictional miniature schema. Not Aurora or the 111-migration target.
 async function read(database=db){
  await database.exec(`begin;set transaction read only;set session authorization ${login};set local role ${worker};`);
  try{
   const r=await database.query<{proof:string}>(FULLSCRIPT_DEPLOYMENT_ROLES_SQL);
   const p=await database.query<{proof:string}>(FULLSCRIPT_DEPLOYMENT_PRIVILEGES_SQL);
   return {roles:JSON.parse(r.rows[0].proof),privileges:JSON.parse(p.rows[0].proof)};
  }finally{await database.exec('rollback;');}
 }
 const before=await read();expect(before.roles).toMatchObject({loginName:login,workerRole:worker,readOnly:true});
 expect(before.roles.loginSchemaCreate).toEqual([]);expect(before.roles.workerSchemaCreate).toEqual([]);
 expect(before.roles.reachableRoles.map((r:Obj)=>r.name).sort()).toEqual([login,worker].sort());
 expect(before.privileges.workerTablePrivileges).toEqual(['fullscript_delivery.draft_intents:INSERT','fullscript_delivery.draft_intents:SELECT','fullscript_delivery.draft_intents:UPDATE']);
 // PGlite keeps SET SESSION AUTHORIZATION as its reset identity; use another
 // miniature database rather than pretending that reset restored postgres.
 const leaked=new PGlite();try{await leaked.exec(schema);await leaked.exec('grant select(id) on clinical_core.private_records to public;');
  const after=await read(leaked);expect(after.privileges.workerTablePrivileges).toContain('clinical_core.private_records:SELECT');
  expect(after.privileges.loginTablePrivileges).toContain('clinical_core.private_records:SELECT');
 }finally{await leaked.close();}
});
