/** Fictional local native engine diagnostic. No AWS, existing database URL,
 * approval, custody, provider, release, activation or deployment inputs. */
import { execFileSync,spawnSync } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,unlinkSync,writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename,isAbsolute,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2),hash=v=>createHash('sha256').update(v).digest('hex');
if(process.platform!=='win32'||args.length!==4||args[0]!=='--binary-directory'||args[2]!=='--driver-directory'
  ||!isAbsolute(args[1])||!isAbsolute(args[3]))throw Error('fullscript_native_owner_arguments_refused');
const bin=realpathSync(args[1]),driver=realpathSync(args[3]),binary=name=>join(bin,name+'.exe');
const package_=JSON.parse(readFileSync(join(driver,'node_modules/pg/package.json'),'utf8'));
if(package_.name!=='pg'||package_.version!=='8.16.3')throw Error('fullscript_native_owner_driver_refused');
const {Client}=createRequire(join(driver,'package.json'))('pg');
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','TEMP','TMP','PATH'].includes(key.toUpperCase())));
function native(name,args){
  const value=spawnSync(binary(name),args,{env:childEnv,encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024,windowsHide:true,
    stdio:name==='pg_ctl'&&args.at(-1)==='start'?'ignore':'pipe'});
  if(value.error||value.status!==0)throw Error('fullscript_native_owner_process_failed:'+name);
  return (value.stdout??'').trim();
}
if(native('postgres',['--version'])!=='postgres (PostgreSQL) 17.7'||native('initdb',['--version'])!=='initdb (PostgreSQL) 17.7')throw Error('fullscript_native_owner_engine_refused');
const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-fullscript-candidate.mjs','--json'],
  {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60_000,windowsHide:true}));
const bundle=await build({stdin:{contents:`export {applyProductionClinicalCoreMigrations} from './src/server/clinical-core/production-migrations.ts';
export {readSourceSchemaMetadata} from './src/server/clinical-core/fullscript-schema-upgrade.ts';
export {verifyFullscriptWorkerMemberships} from './src/server/clinical-core/fullscript-schema-upgrade.ts';
export {careErasurePreservation} from './src/server/clinical-core/care-erasure-schema-upgrade.ts';`,resolveDir:root},
  absWorkingDir:root,bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent',
  // Audit-only export of the unchanged private source function. This does not
  // add any production export, route, grant or weaker metadata comparison.
  plugins:[{name:'source-metadata-audit-port',setup(builder){builder.onLoad({filter:/[\\/]fullscript-schema-upgrade\.ts$/},file=>({
    contents:readFileSync(file.path,'utf8')+'\nexport {schema as readSourceSchemaMetadata};\n',loader:'ts'}));}}]});
const engine=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
const migrations=artifact.manifest.migrations.map(r=>({version:r.version,name:r.file.slice(15,-4),sql:artifact.files[r.file],sha256:hash(artifact.files[r.file])}));
const runs=join(root,'dist','native-fullscript-owner-runs');mkdirSync(runs,{recursive:true});
const directory=mkdtempSync(join(runs,'pg17-')),data=join(directory,'cluster'),pwfile=join(directory,'bootstrap-password');
const bootstrapPassword=randomBytes(32).toString('hex'),ownerPassword=randomBytes(32).toString('hex');
writeFileSync(pwfile,bootstrapPassword+'\n',{flag:'wx',mode:0o600});
const databaseName='alp_fullscript_source_'+randomUUID().replaceAll('-','');
let client,startAttempted=false,report,stage='bootstrap',databaseErrorCode;
try{
  native('initdb',['-D',data,'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+pwfile,'--data-checksums']);unlinkSync(pwfile);
  const socket=createServer();await new Promise((ok,no)=>{socket.once('error',no);socket.listen(0,'127.0.0.1',ok);});
  const port=socket.address().port;await new Promise((ok,no)=>socket.close(error=>error?no(error):ok()));
  startAttempted=true;native('pg_ctl',['-D',data,'-l',join(directory,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -c max_connections=10 -c shared_buffers=32MB -c timezone=UTC`,'-w','-t','30','start']);
  const base={host:'127.0.0.1',port,user:'postgres',password:bootstrapPassword,database:'postgres',ssl:false,
    connectionTimeoutMillis:5000,query_timeout:60_000,application_name:'alp-fictional-native-fullscript-owner',
    options:'-c statement_timeout=60000 -c search_path=pg_catalog,public',replication:false};
  client=new Client(base);await client.connect();
  await client.query(`create role clinical_admin login nosuperuser inherit createdb createrole noreplication nobypassrls password '${ownerPassword}'`);
  await client.query(`create database "${databaseName}" owner clinical_admin`);await client.end();
  client=new Client({...base,user:'clinical_admin',password:ownerPassword,database:databaseName});await client.connect();
  const identity=(await client.query(`select current_database() name,current_user::text owner,session_user::text session_owner,
    current_setting('server_version') version,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit,rolcanlogin,rolreplication
    from pg_roles where rolname=current_user`)).rows[0];
  if(identity.name!==databaseName||identity.owner!=='clinical_admin'||identity.session_owner!=='clinical_admin'||identity.version!=='17.7'
    ||identity.rolsuper!==false||identity.rolbypassrls!==false||identity.rolreplication!==false
    ||identity.rolcreaterole!==true||identity.rolcreatedb!==true||identity.rolinherit!==true||identity.rolcanlogin!==true)throw Error('fullscript_native_owner_identity_refused');
  await client.query('create extension pgcrypto with schema public');
  const query=async(sql,parameters=[])=>{
    try{return await client.query(sql,[...parameters]);}catch(error){if(/^[A-Z0-9]{5}$/.test(error.code??''))databaseErrorCode=error.code;throw error;}
  };
  const db={transaction:async work=>{
    await query('begin');try{const value=await work({query});await query('commit');return value;}
    catch(error){await query('rollback');throw error;}
  }};
  stage='source_install';await engine.applyProductionClinicalCoreMigrations(db,migrations.slice(0,106));
  const migration=migrations[106];await db.transaction(async tx=>{
    await tx.query(migration.sql);await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[migration.version,migration.name,migration.sha256]);
  });
  stage='fictional_fixture';
  await query("insert into clinical_core.organizations(id,organization_label) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','FICTIONAL NATIVE OWNER')");
  await query("insert into clinical_core.persons(id,subject_key) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','subject_fictional_native_owner')");
  // Do not grant RLS bypass or fake rds_superuser to read protected rows. This
  // distinct diagnostic exercises the actual metadata function, not complete
  // operator data preservation or an Aurora authority equivalence.
  stage='metadata_baseline';
  const tables=(await query(engine.careErasurePreservation.tableQuery)).rows;
  if(tables.length!==209)throw Error('fullscript_native_owner_inventory_refused');
  const before=await engine.readSourceSchemaMetadata({query},tables);
  stage='metadata_rehearsal';
  let successor,memberships,negativeCases=0;
  await query('begin');
  try{
    for(const row of migrations.slice(107)){
      await query(row.sql);await query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);
    }
    await engine.verifyFullscriptWorkerMemberships({query});
    successor=await engine.readSourceSchemaMetadata({query},tables);
    memberships=(await query(`select roleid::regrole::text role_name,member::regrole::text member_name,
      grantor::regrole::text grantor_name,admin_option,inherit_option,set_option from pg_auth_members
      where roleid=(select oid from pg_roles where rolname='fullscript_draft_worker')
      or member=(select oid from pg_roles where rolname='fullscript_draft_worker') order by roleid,member,grantor`)).rows;
    for(const grant of [
      'grant fullscript_draft_worker to clinical_core_api with admin true, inherit false, set false',
      'grant fullscript_draft_worker to clinical_admin with admin false, inherit true, set false',
      'grant fullscript_draft_worker to clinical_admin with admin false, inherit false, set true',
      'grant fullscript_draft_worker to clinical_admin with admin false, inherit false, set false',
    ]){
      await query('savepoint fictional_membership_negative');
      try{
        await query(grant);
        let refused=false;
        try{await engine.verifyFullscriptWorkerMemberships({query});}
        catch(error){if(error.category==='verification_failed'&&error.stage==='extension_worker_memberships')refused=true;else throw error;}
        if(!refused)throw Error('fullscript_native_owner_negative_not_refused');
        negativeCases++;
      }finally{await query('rollback to savepoint fictional_membership_negative');await query('release savepoint fictional_membership_negative');}
    }
    await engine.verifyFullscriptWorkerMemberships({query});
  }finally{await query('rollback');}
  stage='post_rollback';const after=await engine.readSourceSchemaMetadata({query},tables);
  const state=(await query(`select (select count(*)::int from clinical_core.schema_migrations) migration_count,
    (select count(*)::int from clinical_core.organizations)+(select count(*)::int from clinical_core.persons) fixture_rows,
    not exists(select 1 from pg_roles where rolname='fullscript_draft_worker') worker_absent,
    to_regnamespace('fullscript_delivery') is null extension_absent`)).rows[0];
  if(before!==after||state.migration_count!==107||state.fixture_rows!==2||!state.worker_absent||!state.extension_absent)
    throw Error('fullscript_native_owner_rollback_not_preserved');
  report={contract:'fullscript-native-owner-source-diagnostic/1',execution:'local_fictional_operator_engine',sourceOnly:true,
    identityProjectionFictional:false,managedRoleSemanticsVerified:false,runtimeAdmission:false,upgradeAuthorized:false,providerAuthorized:false,
    phiAllowed:false,activation:'blocked',databaseOwner:'clinical_admin',postgresVersion:'17.7',
    inspectorBundleSha256:hash(bundle.outputFiles[0].contents),baselineSchema:before,successorHistoricalSchema:successor,postRollbackSchema:after,
    memberships,negativeCases,extensionMembershipsVerified:true,protectedRowsVerified:false,operatorAcceptance:false,rollbackPreserved:true,verdict:before===successor?'passed':'failed'};
}catch(error){
  const safe=new Error('fullscript_native_owner_diagnostic_failed');safe.stage=stage;
  if(/^[a-z_]+$/.test(error.category??''))safe.category=error.category;
  if(databaseErrorCode)safe.databaseErrorCode=databaseErrorCode;throw safe;
}finally{
  if(client)await client.end().catch(()=>{});
  if(startAttempted){
    const state=spawnSync(binary('pg_ctl'),['-D',data,'status'],{env:childEnv,encoding:'utf8',timeout:10_000,windowsHide:true});
    if(state.status===0)native('pg_ctl',['-D',data,'-w','-t','30','-m','fast','stop']);
    else if(state.error||state.status!==3)throw Error('fullscript_native_owner_shutdown_unknown');
    const stopped=spawnSync(binary('pg_ctl'),['-D',data,'status'],{env:childEnv,encoding:'utf8',timeout:10_000,windowsHide:true});
    if(stopped.error||stopped.status!==3)throw Error('fullscript_native_owner_shutdown_unconfirmed');
  }
  try{unlinkSync(pwfile);}catch(error){if(error.code!=='ENOENT')throw error;}
}
report.shutdownConfirmed=true;
writeFileSync(join(directory,'source-diagnostic.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({contract:report.contract,execution:report.execution,verdict:report.verdict,memberships:report.memberships,
  reportDirectory:basename(directory),negativeCases:report.negativeCases,shutdownConfirmed:true,rollbackPreserved:true,identityProjectionFictional:false,
  managedRoleSemanticsVerified:false,protectedRowsVerified:false,operatorAcceptance:false,
  baselineMigrationCount:107,rowCount:2,phiAllowed:false,activation:'blocked',upgradeAuthorized:false,providerAuthorized:false}));
if(report.verdict!=='passed')process.exitCode=1;
