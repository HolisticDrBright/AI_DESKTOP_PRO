/** Local independent rebuild only; not an AWS preflight, deployer or approval. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectCareRegisteredArtifact,refuseRegistered} from './synthetic-care-registered-release.mjs';
export function careRegisteredInspectArguments(args){
 if(args.length!==4||args[0]!=='--v2-root'||args[2]!=='--artifact'
  ||[args[1],args[3]].some(v=>typeof v!=='string'||!v||v.startsWith('--')))refuseRegistered('arguments');
 return {mobileRoot:resolve(args[1]),directory:resolve(args[3])};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careRegisteredInspectArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>inspectCareRegisteredArtifact(process.cwd(),mobileRoot,directory))
  .then(r=>{console.log(JSON.stringify(r));}).catch(error=>{
   const code=error instanceof Error?error.message:'';
   console.error(/^synthetic_care_(?:registered_release|release)_refused:[a-z_]+$/.test(code)?code:'synthetic_care_registered_release_refused:inspect');
   process.exitCode=1;
  });
}
