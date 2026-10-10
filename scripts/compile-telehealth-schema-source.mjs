/** Compile schema fingerprints from validated empty SOURCE in embedded Postgres.
 * No target DB, credential, provider, approval or AWS access. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { projectTelehealthSchema, TELEHEALTH_SCHEMA_PROJECTION } from './telehealth-schema-projection.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url));
export async function compileTelehealthSchemaSource() {
  const artifact=JSON.parse(execFileSync(process.execPath,['scripts/build-zoom-host-authority-candidate.mjs','--json'],
    {cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,timeout:60000,windowsHide:true}));
  if(artifact.candidate.contract!=='zoom-host-authority-candidate/1'||artifact.candidate.activation!=='blocked'||artifact.candidate.phiAllowed!==false
    ||artifact.releaseHash!=='8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e')throw Error('telehealth_schema_compile_artifact_refused');
  const installer=await build({entryPoints:[root+'src/server/clinical-core/production-migrations.ts'],absWorkingDir:root,
    bundle:true,write:false,platform:'node',format:'esm',target:'node22',logLevel:'silent'});
  const installerBytes=installer.outputFiles[0].contents;
  const {applyProductionClinicalCoreMigrations}=await import('data:text/javascript;base64,'+Buffer.from(installerBytes).toString('base64'));
  const db=new PGlite({extensions:{pgcrypto}}), snapshots=[];
  const migrations=artifact.manifest.migrations.map(row=>({version:row.version,name:row.file.slice(15,-4),sql:artifact.files[row.file],sha256:sha(artifact.files[row.file])}));
  try {
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
  } finally {await db.close();}
}
