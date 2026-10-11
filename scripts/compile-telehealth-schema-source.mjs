/** Compile schema fingerprints from validated empty SOURCE in embedded Postgres.
 * No target DB, credential, provider, approval or AWS access. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { projectTelehealthSchema, TELEHEALTH_SCHEMA_PROJECTION } from './telehealth-schema-projection.mjs';
import { assertRestrictedSourceOwnerIdentity, RESTRICTED_SOURCE_OWNER_IDENTITY_SQL } from './telehealth-restricted-source-owner.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url));
async function loadCompilationPlan() {
  const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
    {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,windowsHide:true}));
  if(artifact.candidate.contract!=='zoom-host-authority-candidate/1'||artifact.candidate.activation!=='blocked'||artifact.candidate.phiAllowed!==false
    ||artifact.releaseHash!=='8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e')throw Error('telehealth_schema_compile_artifact_refused');
  const installer=await build({entryPoints:[root+'src/server/clinical-core/production-migrations.ts'],absWorkingDir:root,
    bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
  const installerBytes=installer.outputFiles[0].contents;
  const {applyProductionClinicalCoreMigrations}=await import('data:text/javascript;base64,'+Buffer.from(installerBytes).toString('base64'));
  const migrations=artifact.manifest.migrations.map(row=>({version:row.version,name:row.file.slice(15,-4),sql:artifact.files[row.file],sha256:sha(artifact.files[row.file])}));
  return {artifact,installerBytes,applyProductionClinicalCoreMigrations,migrations};
}
async function compilePrefixes(db,plan) {
    const {artifact,installerBytes,applyProductionClinicalCoreMigrations,migrations}=plan,snapshots=[];
    // Use the actual historical empty installer, including its ledger CHECK,
    // grants and verification. Never reproduce a weaker bootstrap by hand.
    const database={transaction:work=>db.transaction(tx=>work({query:(sql,args=[])=>tx.query(sql,[...args])}))};
    await applyProductionClinicalCoreMigrations(database,migrations.slice(0,106));
    await db.exec('set search_path=pg_catalog,public');
    for(let i=106;i<migrations.length;i++){
      const row=migrations[i];
      await db.transaction(async tx=>{
        await tx.exec(row.sql);
        await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)',[row.version,row.name,row.sha256]);
      });
      if(i>=111){
        const projection=await projectTelehealthSchema((sql,args)=>db.query(sql,[...args]));
        const rows=artifact.manifest.migrations.slice(0,i+1);
        snapshots.push({migrationCount:i+1,migrationReleaseSha256:sha(rows.map(r=>r.version+':'+sha(artifact.files[r.file])).join('\n')),
          assemblySha256:sha(rows.map(r=>r.version+':'+r.file+':'+sha(artifact.files[r.file])).join('\n')),
          schemaSha256:sha(JSON.stringify(projection)),projection});
      }
    }
    return {contract:'telehealth-schema-source/1',sourceOnly:true,activation:'blocked',phiAllowed:false,
      installerBundleSha256:sha(installerBytes),projectionSqlSha256:sha(TELEHEALTH_SCHEMA_PROJECTION),
      postgresVersion:(await db.query('show server_version')).rows[0].server_version,snapshots};
}
export async function compileTelehealthSchemaSource() {
  const plan=await loadCompilationPlan(),db=new PGlite({extensions:{pgcrypto}});
  try {return await compilePrefixes(db,plan);} finally {await db.close();}
}

/** Native source compilation is allowed only on a fresh, randomly named source
 * database. This entry point cannot admit the AWS qualification/staging target
 * and its output is not accepted by the existing 18.3 runtime inspector. */
export async function compileTelehealthSchemaNativeSource(db) {
  const identity=(await db.query("select current_database() database_name,current_user::text owner,current_setting('server_version') version")).rows;
  if(identity.length!==1||!/^alp_source_[a-f0-9]{32}$/.test(identity[0].database_name)
    ||identity[0].owner!=='postgres'||identity[0].version!=='17.7')throw Error('telehealth_native_source_identity_refused');
  const existing=(await db.query(`select
    (select count(*) from pg_namespace where nspname like 'clinical\\_%' escape '\\' or nspname in('commercial_reference','fullscript_delivery'))::int namespaces,
    (select count(*) from pg_roles where rolname like 'clinical\\_%' escape '\\' or rolname like 'fullscript\\_%' escape '\\')::int roles,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p','f','v','m','S'))::int public_relations`)).rows;
  if(existing.length!==1||existing[0].namespaces!==0||existing[0].roles!==0||existing[0].public_relations!==0)
    throw Error('telehealth_native_source_not_empty');
  return compilePrefixes(db,await loadCompilationPlan());
}

/** Independent local non-superuser source compilation. This contract is not
 * accepted by the existing runtime inspector and cannot admit AWS targets. */
export async function compileTelehealthSchemaRestrictedOwnerSource(db) {
  const ownerProfile=assertRestrictedSourceOwnerIdentity((await db.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
  const existing=(await db.query(`select
    (select count(*) from pg_namespace where nspname like 'clinical\\_%' escape '\\' or nspname in('commercial_reference','fullscript_delivery'))::int namespaces,
    (select count(*) from pg_roles where (rolname like 'clinical\\_%' escape '\\' or rolname like 'fullscript\\_%' escape '\\') and rolname<>'clinical_admin')::int roles,
    (select count(*) from pg_auth_members where member=(select oid from pg_roles where rolname=current_user))::int memberships,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p','f','v','m','S'))::int public_relations`)).rows;
  if(existing.length!==1||Object.keys(existing[0]).sort().join(',')!=='memberships,namespaces,public_relations,roles'
    ||Object.values(existing[0]).some(value=>value!==0))throw Error('telehealth_restricted_source_not_empty');
  const compiled=await compilePrefixes(db,await loadCompilationPlan());
  assertRestrictedSourceOwnerIdentity((await db.query(RESTRICTED_SOURCE_OWNER_IDENTITY_SQL)).rows);
  return {...compiled,contract:'telehealth-restricted-owner-source/1',ownerProfile};
}
