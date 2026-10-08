/** Build the embedded continuation port. No AWS call or CLI lasting upgrade. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {readHistoricalCareParentMigrations} from './care-canonical-migrations.mjs';
const historicalSourceOnly=process.argv.length===3&&process.argv[2]==='--historical-source-only';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {careIntentMigrationBinding} from './synthetic-care-intent-release.mjs';
if((!historicalSourceOnly&&process.argv.length!==2))throw Error('care_intent_release_build_arguments');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!historicalSourceOnly&&!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','.github',
 'package.json','package-lock.json','.gitattributes'],{encoding:'utf8',windowsHide:true}).trim();
const load=folder=>{
 const dir=`infra/aws-clinical-core/${folder}/`,manifest=JSON.parse(readFileSync(dir+'manifest.json','utf8'));
 if(manifest.contract_version!=='clinical-core-migrations/1')throw Error('care_intent_release_manifest');
 return manifest.migrations.map(x=>{
  if(!/^\d{14}_[a-z0-9_]+\.sql$/.test(x.file)||!x.file.startsWith(x.version+'_'))throw Error('care_intent_release_manifest');
  const sql=readFileSync(dir+x.file,'utf8').replace(/\r\n?/g,'\n');return {version:x.version,name:x.file.slice(15,-4),sql,sha256:sha256(sql)};
 });
};
const migrations=historicalSourceOnly?readHistoricalCareParentMigrations(process.cwd()):load('migrations'),reference=load('catalog-migrations'),mapping=careIntentMigrationBinding(process.cwd(),historicalSourceOnly);
const sql=readFileSync('infra/aws-clinical-core/source-candidates/care-erasure-intents.sql','utf8').replace(/\r\n?/g,'\n');
const overlay={...mapping.overlay,sql};
if(migrations.length!==46||reference.length!==2||sha256(sql)!==mapping.overlay.sha256
 ||mapping.sourceBefore!==P.sourceAfter||mapping.liveBefore!==P.liveAfter)throw Error('care_intent_release_history');
const directory='dist/aws-clinical-core/care-erasure-intent-release';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/clinical-core/care-erasure-intent-release-database.ts'],outfile:directory+'/index.cjs',bundle:true,
 platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:false,legalComments:'none',treeShaking:true,
 define:{__CARE_INTENT_RELEASE_BUILD__:JSON.stringify({sourceCommit,clean}),__CARE_INTENT_RELEASE_MIGRATIONS__:JSON.stringify(migrations),
  __CARE_INTENT_RELEASE_REFERENCE__:JSON.stringify(reference),__CARE_INTENT_RELEASE_OVERLAY__:JSON.stringify(overlay)}});
writeFileSync(directory+'/artifact-manifest.json',JSON.stringify({contract:'care-intent-release-database-build/1',sourceCommit,clean,historicalSourceOnly,
 sha256:sha256(readFileSync(directory+'/index.cjs')),execution:'synthetic-staging',phiAllowed:false,
 embeddedMigrations:true,embeddedReferenceMigrations:true,embeddedOverlay:true,targetOverrides:false,
 releaseMapping:mapping,mandatoryFreshCompatibleRecovery:true,mandatoryDeploymentReadback:true,mandatoryRollbackRehearsal:true,
 standaloneUpgradeAvailable:false,canonicalRegistered:false,migrationPerformed:false,hostedAcceptance:false},null,2)+'\n');
console.log(JSON.stringify({built:true,sourceCommit,clean,migrationPerformed:false,standaloneUpgradeAvailable:false,phiAllowed:false}));
