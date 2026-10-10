// Local build only; no AWS client, review, upload or deployment action.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
if(process.argv.length!==2)throw Error('fullscript_preflight_build_arguments_refused');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8',windowsHide:true}).trim();
const directory='dist/aws-clinical-core/fullscript-deployment-preflight';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/fullscript/qualification-deployment-command.ts'],outfile:directory+'/index.cjs',
 bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:true,legalComments:'none',
 define:{__FULLSCRIPT_PREFLIGHT_BUILD__:JSON.stringify({sourceCommit,clean})}});
console.log(JSON.stringify({contract:'fullscript-preflight-build/1',sourceCommit,clean,deployed:false,phiAllowed:false}));
