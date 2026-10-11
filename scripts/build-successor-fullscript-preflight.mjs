import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {inventorySourceIdentity} from './inventory-qualification-source.mjs';
const args=process.argv.slice(2);
if(args.length>1||args.length&&!/^--out-dir=.+$/.test(args[0]))throw Error('successor_fullscript_preflight_argument_refused');
const source=inventorySourceIdentity();
if(source.sourceClean!==true)throw Error('successor_fullscript_preflight_clean_source_required');
const out=resolve(args.length?args[0].slice(10):'dist/aws-clinical-core/successor-fullscript-preflight');
mkdirSync(out,{recursive:true});
await build({entryPoints:['src/server/fullscript/successor-deployment-preflight-command.ts'],outfile:join(out,'index.cjs'),
 bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:true,legalComments:'none',
 define:{__SUCCESSOR_FULLSCRIPT_PREFLIGHT_SOURCE__:JSON.stringify(source)}});
if(JSON.stringify(inventorySourceIdentity())!==JSON.stringify(source))throw Error('successor_fullscript_preflight_source_changed');
const manifest={contract:'successor-fullscript-preflight-build/1',...source,
 executableSha256:createHash('sha256').update(readFileSync(join(out,'index.cjs'))).digest('hex'),
 awsActionsAllowed:false,providerActionsAllowed:false,deploymentAllowed:false,phiAllowed:false,activation:'blocked'};
writeFileSync(join(out,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
