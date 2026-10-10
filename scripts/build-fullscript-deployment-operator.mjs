// Local artifact only. Never rebuilds the separately approved schema operator.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.length!==2)throw Error('fullscript_deployment_build_arguments_refused');
const options={encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:10000,maxBuffer:1024*1024};
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],options).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra','package.json','package-lock.json','.gitattributes','.github'],options).trim();
const directory='dist/aws-clinical-core/fullscript-deployment-operator';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/fullscript/qualification-deployment-native-command.ts'],outfile:directory+'/index.cjs',
 bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:true,legalComments:'none',
 define:{__FULLSCRIPT_DEPLOYMENT_BUILD__:JSON.stringify({sourceCommit,clean})}});
const bytes=readFileSync(directory+'/index.cjs');if(bytes.length>16*1024*1024)throw Error('fullscript_deployment_build_size_refused');
console.log(JSON.stringify({contract:'fullscript-deployment-operator-build/1',sourceCommit,clean,operatorSha256:createHash('sha256').update(bytes).digest('hex'),
 bytes:bytes.length,deployed:false,providerActionPerformed:false,phiAllowed:false}));
