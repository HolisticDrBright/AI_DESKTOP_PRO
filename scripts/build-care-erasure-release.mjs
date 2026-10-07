/** Build the fixed, embedded database port. No AWS or lasting schema action. */
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {build} from 'esbuild';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
if(process.argv.length!==2)throw Error('care_erasure_release_build_arguments');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','.github',
 'package.json','package-lock.json','.gitattributes'],{encoding:'utf8',windowsHide:true}).trim();
const load=folder=>{
 const dir=`infra/aws-clinical-core/${folder}/`,manifest=JSON.parse(readFileSync(dir+'manifest.json','utf8'));
 if(manifest.contract_version!=='clinical-core-migrations/1')throw Error('care_erasure_release_manifest');
 return manifest.migrations.map(x=>{
  if(!/^\d{14}_[a-z0-9_]+\.sql$/.test(x.file)||!x.file.startsWith(x.version+'_'))throw Error('care_erasure_release_manifest');
  const sql=readFileSync(dir+x.file,'utf8').replace(/\r\n?/g,'\n');return {version:x.version,name:x.file.slice(15,-4),sql,sha256:sha256(sql)};
 });
};
const migrations=load('migrations'),reference=load('catalog-migrations'),rows=v=>v.map(({version,name,sha256})=>({version,name,sha256}));
if(migrations.length!==46||reference.length!==2||sha256(JSON.stringify(rows(migrations)))!==P.sourceAfter
 ||sha256(JSON.stringify(rows(reference)))!==P.reference)throw Error('care_erasure_release_history');
const dir='dist/aws-clinical-core/care-erasure-release';mkdirSync(dir,{recursive:true});
await build({entryPoints:['src/server/clinical-core/care-erasure-release-database.ts'],outfile:dir+'/index.cjs',bundle:true,
 platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:false,legalComments:'none',treeShaking:true,
 define:{__CARE_ERASURE_UPGRADE_BUILD__:JSON.stringify({sourceCommit,clean}),__CARE_ERASURE_MIGRATIONS__:JSON.stringify(migrations),
 __CARE_ERASURE_REFERENCE_MIGRATIONS__:JSON.stringify(reference)}});
writeFileSync(dir+'/artifact-manifest.json',JSON.stringify({contract:'synthetic-care-erasure-release-build/1',sourceCommit,clean,
 sha256:sha256(readFileSync(dir+'/index.cjs')),execution:'synthetic-staging',phiAllowed:false,migrationPerformed:false,
 embeddedMigrations:true,embeddedReferenceMigrations:true,targetOverrides:false,expectedLiveBefore:46,expectedLiveAfter:47,
 mandatoryFreshRoutingRecovery:true,mandatoryRollbackRehearsal:true},null,2)+'\n');
console.log(JSON.stringify({built:true,sourceCommit,clean,phiAllowed:false,migrationPerformed:false}));
