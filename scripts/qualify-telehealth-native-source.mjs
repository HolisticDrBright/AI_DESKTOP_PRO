/** Local disposable-source qualification, optionally with fictional SQL races.
 * No AWS/provider transport, existing database URL, target manifest, activation
 * or credential input is supported. */
import { spawnSync,execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTelehealthSchemaNativeSource, compileTelehealthSchemaRestrictedOwnerSource } from './compile-telehealth-schema-source.mjs';
import { TELEHEALTH_SCHEMA_NAMES,projectTelehealthSchema } from './telehealth-schema-projection.mjs';
import { runTelehealthNativeRaces } from './telehealth-native-races.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const refuse=()=>{throw Error('telehealth_native_source_arguments_refused');};
const args=process.argv.slice(2);
const restrictedOwner=args.length===6&&args[4]==='--owner-profile'&&args[5]==='clinical-admin';
const keyFence=args.length===8&&args[6]==='--candidate'&&args[7]==='key-fence';
const matrix=(args.length===6||keyFence)&&args[4]==='--matrix'&&args[5]==='telehealth-transfer';
if(process.platform!=='win32'||!(args.length===4||matrix||restrictedOwner)||args[0]!=='--binary-directory'||args[2]!=='--driver-directory'
  ||!isAbsolute(args[1])||!isAbsolute(args[3]))refuse();
const bin=realpathSync(args[1]),driver=realpathSync(args[3]);
const binary=name=>join(bin,name+'.exe');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pgPackage=JSON.parse(readFileSync(join(driver,'node_modules/pg/package.json'),'utf8'));
if(pgPackage.name!=='pg'||pgPackage.version!=='8.16.3')refuse();
const require=createRequire(join(driver,'package.json'));
const {Client}=require('pg');
// Native children never inherit database URLs, cloud credentials or provider
// keys. The driver receives a complete explicit loopback-only configuration.
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','TEMP','TMP','PATH'].includes(key.toUpperCase())));
function run(name,arguments_,input) {
  const result=spawnSync(binary(name),arguments_,{env:childEnv,input,encoding:'utf8',timeout:60_000,
    maxBuffer:4*1024*1024,windowsHide:true,
    // A long-lived Windows server must not retain the parent's captured pipes.
    // PostgreSQL already writes its own output to the explicit per-run log.
    stdio:name==='pg_ctl'&&arguments_.at(-1)==='start'?'ignore':'pipe'});
  if(result.error||result.status!==0)throw Error('telehealth_native_source_process_failed:'+name);
  return (result.stdout??'').trim();
}
if(run('postgres',['--version'])!=='postgres (PostgreSQL) 17.7'
  ||run('initdb',['--version'])!=='initdb (PostgreSQL) 17.7')refuse();
const runs=join(root,'dist','native-source-runs');mkdirSync(runs,{recursive:true});
const runDirectory=mkdtempSync(join(runs,'pg17-')),data=join(runDirectory,'cluster');
const password=randomBytes(32).toString('hex'),passwordFile=join(runDirectory,'bootstrap-password');
writeFileSync(passwordFile,password+'\n',{flag:'wx',mode:0o600});
const databaseName=(restrictedOwner?'alp_owner_source_':'alp_source_')+randomUUID().replaceAll('-','');
const ownerPassword=restrictedOwner?randomBytes(32).toString('hex'):undefined;
let startAttempted=false,client,inventoryClient,report,stage='bootstrap',lastDatabaseErrorCode;
try {
  run('initdb',['-D',data,'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+passwordFile,'--data-checksums']);
  unlinkSync(passwordFile);
  const socket=createServer();await new Promise((ok,no)=>{socket.once('error',no);socket.listen(0,'127.0.0.1',ok);});
  const port=socket.address().port;await new Promise((ok,no)=>socket.close(error=>error?no(error):ok()));
  startAttempted=true;
  run('pg_ctl',['-D',data,'-l',join(runDirectory,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -c max_connections=10 -c shared_buffers=32MB -c timezone=UTC`,'-w','-t','30','start']);
  const configuration={host:'127.0.0.1',port,user:'postgres',password,database:'postgres',ssl:false,
    connectionTimeoutMillis:5_000,query_timeout:60_000,application_name:'alp-empty-source-only',
    options:'-c statement_timeout=60000 -c search_path=pg_catalog,public',replication:false};
  client=new Client(configuration);await client.connect();
  // Database identifier is generated here, never supplied by the caller.
  if(restrictedOwner){
    // Own local cluster only: bootstrap creates the source owner and its fresh
    // database, then disconnects. No migration/projection runs as postgres.
    await client.query(`create role clinical_admin login nosuperuser inherit createdb createrole noreplication nobypassrls password '${ownerPassword}'`);
  }
  await client.query(`create database "${databaseName}"${restrictedOwner?' owner clinical_admin':''}`);await client.end();
  const ownerConfiguration={...configuration,database:databaseName,...(restrictedOwner?{user:'clinical_admin',password:ownerPassword}:{})};
  client=new Client(ownerConfiguration);await client.connect();
  stage='compile';
  // Match the embedded compiler's explicitly installed public pgcrypto. With
  // pg_catalog first in search_path, an unqualified fresh CREATE EXTENSION
  // otherwise tries to install there and collides with built-in UUID functions.
  await client.query('create extension pgcrypto with schema public');
  // Deliberately perturb object OIDs without adding objects to projected schemas.
  await client.query('create schema alp_source_oid_noise; create table alp_source_oid_noise.unrelated(id integer primary key)');
  const connection=client;
  const execute=async(sql,args=[])=>{try{return await connection.query(sql,[...args]);}
    catch(error){if(/^[A-Z0-9]{5}$/.test(error?.code??''))lastDatabaseErrorCode=error.code;throw error;}};
  const db={query:execute,exec:sql=>execute(sql),
    transaction:async work=>{await connection.query('begin');try{const value=await work(db);await connection.query('commit');return value;}
      catch(error){await connection.query('rollback');throw error;}}};
  const compiled=await (restrictedOwner?compileTelehealthSchemaRestrictedOwnerSource(db):compileTelehealthSchemaNativeSource(db));
  stage='empty-inventory';
  if(compiled.postgresVersion!=='17.7'||compiled.snapshots.map(s=>s.migrationCount).join(',')!=='112,113,114')refuse();
  // Forced-RLS/private tables cannot all be counted by the restricted owner.
  // A separately identified local bootstrap auditor checks only row counts,
  // in a read-only transaction. It does not compile, project, grant or migrate.
  let inventory=client;
  if(restrictedOwner){
    inventoryClient=new Client({...configuration,database:databaseName});await inventoryClient.connect();
    inventory=inventoryClient;
    await inventory.query('begin read only');
    const auditor=(await inventory.query("select current_user::text owner,session_user::text session_owner,rolsuper from pg_roles where rolname=current_user")).rows;
    if(auditor.length!==1||auditor[0].owner!=='postgres'||auditor[0].session_owner!=='postgres'||auditor[0].rolsuper!==true)refuse();
  }
  const tables=(await inventory.query(`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in(select jsonb_array_elements_text($1::jsonb)) and c.relkind in('r','p')
    and not(n.nspname='clinical_core' and c.relname='schema_migrations') order by n.nspname,c.relname`,[JSON.stringify(TELEHEALTH_SCHEMA_NAMES)])).rows;
  if(tables.length<150||tables.length>500)throw Error('telehealth_native_source_table_count_refused');
  const quote=name=>'"'+name.replaceAll('"','""')+'"';
  for(const table of tables){
    const count=(await inventory.query(`select count(*)::int count from ${quote(table.nspname)}.${quote(table.relname)}`)).rows;
    if(count.length!==1||count[0].count!==0)throw Error('telehealth_native_source_seeded_records_refused');
  }
  if(inventoryClient){await inventoryClient.query('rollback');await inventoryClient.end();inventoryClient=undefined;}
  report={contract:'telehealth-native-source-qualification/1',execution:restrictedOwner?'local_restricted_owner_source':'local_empty_source',
    sourceOnly:true,phiAllowed:false,activation:'blocked',providerAuthorized:false,upgradeAuthorized:false,
    databaseOwner:restrictedOwner?'clinical_admin':'postgres',postgresVersion:'17.7',driverVersion:'8.16.3',
    ...(restrictedOwner?{managedRoleSemanticsVerified:false,runtimeAdmission:false,emptyInventoryOwner:'postgres',emptyInventoryReadOnly:true}:{}),
    binarySha256:hash(readFileSync(binary('postgres'))),emptyApplicationTables:true,applicationTableCount:tables.length,compiled};
  if(matrix){
    stage='race-matrix';
    delete report.emptyApplicationTables;
    report.sourceTablesInitiallyEmpty=true;
    report.execution='local_fictional_sql_matrix';
    if(keyFence){
      const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-telehealth-transfer-key-fence-candidate.mjs','--json'],
        {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60_000,windowsHide:true}));
      const row=artifact.manifest.migrations.at(-1),sql=artifact.files[row.file];
      if(artifact.candidate.contract!=='telehealth-transfer-key-fence-candidate/1'||artifact.candidate.phiAllowed!==false
        ||artifact.candidate.activation!=='blocked'||artifact.candidate.parentArtifactSha256!==compiled.snapshots.at(-1).assemblySha256)refuse();
      await client.query('begin');
      try{
        await client.query(sql);
        await client.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.file.slice(15,-4),hash(sql)]);
        await client.query('commit');
      }catch(error){await client.query('rollback');throw error;}
      report.sourceExtension={...artifact.candidate,assemblySha256:artifact.releaseHash,
        localSchemaSha256:hash(JSON.stringify(await projectTelehealthSchema((sql,args)=>client.query(sql,args))))};
    }
    report.races=await runTelehealthNativeRaces(client,async()=>{
      const session=new Client({...configuration,database:databaseName});await session.connect();return session;
    });
  }
} catch(error) {
  // Do not print the data-URL installer stack, query text, environment or keys.
  const failure=new Error('telehealth_native_source_run_failed');
  failure.stage=stage;
  if(/^[A-Z0-9]{5}$/.test(error?.code??''))failure.databaseErrorCode=error.code;
  else if(lastDatabaseErrorCode)failure.databaseErrorCode=lastDatabaseErrorCode;
  if(/^telehealth_native_race_[a-z_]+$/.test(error?.message??''))failure.raceRefusal=error.message;
  if(['migration_failed','history_mismatch','verification_failed'].includes(error?.category))failure.category=error.category;
  if(/^\d{14}$/.test(error?.version??''))failure.migrationVersion=error.version;
  if(Number.isSafeInteger(error?.statementIndex))failure.statementIndex=error.statementIndex;
  throw failure;
} finally {
  if(inventoryClient)await inventoryClient.end().catch(()=>{});
  if(client)await client.end().catch(()=>{});
  if(startAttempted){
    const status=spawnSync(binary('pg_ctl'),['-D',data,'status'],{env:childEnv,encoding:'utf8',timeout:10_000,windowsHide:true});
    if(status.status===0)run('pg_ctl',['-D',data,'-w','-t','30','-m','fast','stop']);
    else if(status.error||status.status!==3)throw Error('telehealth_native_source_shutdown_unknown');
    const stopped=spawnSync(binary('pg_ctl'),['-D',data,'status'],{env:childEnv,encoding:'utf8',timeout:10_000,windowsHide:true});
    if(stopped.error||stopped.status!==3)throw Error('telehealth_native_source_shutdown_unconfirmed');
  }
  // Preserve only this test's cluster, log and source report. No recursive
  // deletion or uncertain-process kill; a shutdown failure is a failed run.
  try {unlinkSync(passwordFile);} catch(error) {if(error.code!=='ENOENT')throw error;}
}
// A report is published only after the owned native cluster is confirmed stopped.
report.shutdownConfirmed=true;
writeFileSync(join(runDirectory,'source-qualification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({contract:report.contract,execution:report.execution,postgresVersion:report.postgresVersion,
  databaseOwner:report.databaseOwner,reportDirectory:basename(runDirectory),shutdownConfirmed:true,
  emptyApplicationTables:report.emptyApplicationTables,applicationTableCount:report.applicationTableCount,
  ...(report.races?{races:report.races}:{}),
  ...(report.sourceExtension?{sourceExtension:report.sourceExtension}:{}),
  snapshots:report.compiled.snapshots.map(({migrationCount,schemaSha256,projection})=>({migrationCount,schemaSha256,items:projection.length})),
  phiAllowed:false,activation:'blocked',providerAuthorized:false,upgradeAuthorized:false}));
if(report.races?.verdict==='failed')process.exitCode=1;
