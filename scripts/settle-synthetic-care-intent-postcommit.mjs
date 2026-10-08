import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {refuseIntent} from './synthetic-care-intent-release.mjs';
import {settleCareIntentPostcommit} from './care-intent-postcommit-settlement.mjs';
import {intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
export function careIntentPostcommitSettlementArgs(a){
 if(a.length!==5||a[0]!=='--v2-root'||a[2]!=='--candidate'
  ||a[4]!=='--archive-reconciled-fictional-intent-custody-only'||!a[1]?.trim()||!a[3]?.trim()
  ||a[1].startsWith('--')||a[3].startsWith('--'))refuseIntent('postcommit_retirement_arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careIntentPostcommitSettlementArgs(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>settleCareIntentPostcommit(process.cwd(),mobileRoot,directory))
  .then(result=>console.log(JSON.stringify(result)))
  .catch(e=>{console.error(intentFailureCode(e));process.exitCode=1;});
}
