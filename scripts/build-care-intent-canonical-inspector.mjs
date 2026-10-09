/** Current 47-row registry embedded in a read-only, fixed-target inspector. */
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {readCanonicalCareMigrations} from './care-canonical-migrations.mjs';
import {sha256} from './synthetic-care-release.mjs';
if(process.argv.length!==2)throw Error('care_canonical_inspector_arguments_refused');
const {migrations,reference,mapping}=readCanonicalCareMigrations(process.cwd());
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','.github',
 'package.json','package-lock.json','.gitattributes'],{encoding:'utf8',windowsHide:true}).trim();
const directory='dist/aws-clinical-core/care-intent-canonical-inspector';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/clinical-core/care-erasure-canonical-registration-operator.ts'],outfile:directory+'/index.cjs',
 bundle:true,platform:'node',target:'node22',format:'cjs',minify:false,sourcemap:false,legalComments:'none',treeShaking:true,
 define:{__CARE_CANONICAL_BUILD__:JSON.stringify({sourceCommit,clean}),__CARE_CANONICAL_MIGRATIONS__:JSON.stringify(migrations),
  __CARE_CANONICAL_REFERENCE__:JSON.stringify(reference)}});
const manifest={contract:'care-intent-canonical-inspector-build/1',sourceCommit,clean,sha256:sha256(readFileSync(directory+'/index.cjs')),
 mapping,inspectionOnly:true,schemaReplayAvailable:false,ledgerRewriteAvailable:false,releaseAccepted:false,phiAllowed:false};
writeFileSync(directory+'/artifact-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
