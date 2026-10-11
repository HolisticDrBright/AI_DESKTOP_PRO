// Clean-source local producer only; never rebuilds the schema operator.
import {build} from 'esbuild';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inventorySourceIdentity} from './inventory-qualification-source.mjs';
if(process.argv.length!==2)throw Error('successor_fullscript_deployment_build_arguments_refused');
const source=inventorySourceIdentity();
if(source.sourceClean!==true)throw Error('successor_fullscript_deployment_clean_source_required');
const directory='dist/aws-clinical-core/successor-fullscript-deployment-operator';mkdirSync(directory,{recursive:true});
await build({entryPoints:['src/server/fullscript/successor-deployment-native-command.ts'],outfile:directory+'/index.cjs',
 bundle:true,platform:'node',target:'node22',format:'cjs',sourcemap:false,minify:true,legalComments:'none',
 define:{__SUCCESSOR_FULLSCRIPT_DEPLOYMENT_BUILD__:JSON.stringify(source)}});
if(JSON.stringify(inventorySourceIdentity())!==JSON.stringify(source))throw Error('successor_fullscript_deployment_source_changed');
const bytes=readFileSync(directory+'/index.cjs');if(bytes.length>16*1024*1024)throw Error('successor_fullscript_deployment_build_size_refused');
const manifest={contract:'successor-fullscript-deployment-operator-build/1',...source,
 operatorSha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
 deployed:false,providerActionPerformed:false,completeFleetQualified:false,hostedQualified:false,phiAllowed:false,activation:'blocked'};
writeFileSync(directory+'/artifact-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
