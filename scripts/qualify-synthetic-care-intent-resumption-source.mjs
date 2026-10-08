/** Source-only qualification. No custody handoff or AWS command is available. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readCareIntentCandidate,refuseIntent} from './synthetic-care-intent-release.mjs';
import {qualifyCareIntentResumptionSource} from './care-intent-resumption-source.mjs';
export function careIntentResumptionSourceArgs(args){
 if(args.length!==5||args[0]!=='--v2-root'||args[2]!=='--candidate'
  ||args[4]!=='--qualify-interrupted-application-source-only'
  ||typeof args[1]!=='string'||!args[1]||args[1].startsWith('--')
  ||typeof args[3]!=='string'||!args[3]||args[3].startsWith('--'))refuseIntent('resume_source_arguments');
 return {mobileRoot:resolve(args[1]),directory:resolve(args[3])};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careIntentResumptionSourceArgs(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>qualifyCareIntentResumptionSource(process.cwd(),mobileRoot,readCareIntentCandidate(directory)))
  .then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{
   const message=error?.message??'';
   console.error(/^synthetic_care_(?:intent_)?release_refused:[a-z0-9_]{1,180}$/.test(message)
    ?message:'synthetic_care_intent_release_refused:resume_source_unconfirmed');
   process.exitCode=1;
  });
}
