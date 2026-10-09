/** Explicit, nonexecuting two-resource dependency profile. No execution,
 * schema mutation, saved-report authority, target override or PHI activation. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCareIntentUpload,intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
import {proposeCareIntentDependencyCodeChange} from './prepare-synthetic-care-intent-code-change.mjs';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==5||args[0]!=='--v2-root'||args[2]!=='--candidate'
  ||args[4]!=='--prepare-fictional-intent-dependency-change-only'||args[1].startsWith('--')||args[3].startsWith('--'))refuseIntent('arguments');
 const root=process.cwd(),directory=resolve(args[3]);
 console.log(JSON.stringify(await runCareIntentUpload(root,resolve(args[1]),directory,
  context=>proposeCareIntentDependencyCodeChange(root,directory,context))));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(intentFailureCode(error));process.exitCode=1;});
}
