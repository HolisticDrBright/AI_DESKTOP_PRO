// Source build only. No AWS request, upload, approval, route or deployment.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {careMessagingZip} from './care-messaging-zip.mjs';
if(process.argv.length!==2)throw Error('fullscript_api_build_arguments_refused');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const clean=!execFileSync('git',['status','--porcelain','--untracked-files=all','--','src','scripts','infra',
 'package.json','package-lock.json','.gitattributes','.github'],{encoding:'utf8',windowsHide:true}).trim();
const out='dist/aws-clinical-core/fullscript-api';mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/fullscript/qualification-lambda.ts'],outfile:`${out}/index.js`,bundle:true,
 platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:true,legalComments:'none',
 define:{__FULLSCRIPT_API_BUILD__:JSON.stringify({sourceCommit,clean})}});
const code=readFileSync(`${out}/index.js`),zip=careMessagingZip(code),hash=v=>createHash('sha256').update(v).digest('hex');
writeFileSync(`${out}/function.zip`,zip);
const manifest={contract:'fullscript-api-build/1',sourceCommit,clean,handler:'index.handler',runtime:'nodejs22.x',
 indexSha256:hash(code),zipSha256:hash(zip),codeSha256:createHash('sha256').update(zip).digest('base64'),
 execution:'qualification_only',phiAllowed:false,activation:'blocked',targetEmbedded:false,
 immutableTargetVersionRequired:true,targetReviewRequired:true,publishedVersionRequired:true,
 deployed:false,hostedQualified:false,providerActionPerformed:false};
writeFileSync(`${out}/artifact-manifest.json`,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
