/** Embedded fixed-target inspection/rollback runner. No lasting DDL or AWS call at build time. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {digest,normalized,sourceMapping,CARE_ERASURE_RECOVERY_SUCCESSOR} from './build-care-erasure-recovery-source.mjs';
if(process.argv.length!==2)throw new Error('care_intent_build_arguments_refused');
const load=folder=>{
 const dir=`infra/aws-clinical-core/${folder}/`,manifest=JSON.parse(readFileSync(dir+'manifest.json','utf8'));
 if(manifest.contract_version!=='clinical-core-migrations/1')throw new Error('care_intent_manifest_refused');
 return manifest.migrations.map(v=>{
  if(!/^\d{14}_[a-z0-9_]+\.sql$/.test(v.file)||!v.file.startsWith(v.version+'_'))throw new Error('care_intent_manifest_refused');
  const sql=normalized(readFileSync(dir+v.file,'utf8'));
  return {version:v.version,name:v.file.slice(15,-4),sql,sha256:digest(sql)};
 });
};
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--',
 'src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8'}).trim();
const migrations=load('migrations'),reference=load('catalog-migrations');
if(reference.length!==2||digest(JSON.stringify(reference.map(({version,name,sha256})=>({version,name,sha256}))))
 !=='83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62')throw new Error('care_intent_reference_refused');
const sql=normalized(readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8'));
const mapping=sourceMapping(migrations,sql,sourceCommit,!clean);
const overlay={version:CARE_ERASURE_RECOVERY_SUCCESSOR.version,name:CARE_ERASURE_RECOVERY_SUCCESSOR.name,sql,sha256:digest(sql)};
const directory='dist/aws-clinical-core/care-erasure-intent-operator';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/clinical-core/care-erasure-intent-operator.ts'],outfile:directory+'/index.cjs',
 bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,legalComments:'none',treeShaking:true,
 define:{__CARE_INTENT_BUILD__:JSON.stringify({sourceCommit,clean}),__CARE_INTENT_MIGRATIONS__:JSON.stringify(migrations),
  __CARE_INTENT_REFERENCE__:JSON.stringify(reference),__CARE_INTENT_OVERLAY__:JSON.stringify(overlay)}});
writeFileSync(directory+'/artifact-manifest.json',JSON.stringify({contract:'care-erasure-intent-operator-build/1',sourceCommit,clean,
 sha256:digest(readFileSync(directory+'/index.cjs')),execution:'synthetic-staging',phiAllowed:false,
 embeddedMigrations:true,embeddedReferenceMigrations:true,embeddedOverlay:true,targetOverrides:false,
 inspectionAvailable:true,rollbackRehearsalAvailable:true,lastingUpgradeAvailable:false,apiRecoveryRequired:true,
 canonicalRegistered:false,migrationPerformed:false,hostedAcceptance:false,releaseMapping:mapping.candidateLedgerMapping},null,2)+'\n');
console.log(JSON.stringify({built:true,sourceCommit,clean,execution:'synthetic-staging',phiAllowed:false,
 inspectionAvailable:true,rollbackRehearsalAvailable:true,lastingUpgradeAvailable:false,migrationPerformed:false}));
