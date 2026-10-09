/** Fixed synthetic-only apply. No target, SQL, approval or PHI override. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runCatalogForwardCustodied} from './rehearse-catalog-forward-rollback.mjs';
export function catalogApplyArguments(args){
 if(args.length!==1||args[0]!=='--apply-reviewed-synthetic-catalog-forward')throw Error('catalog_forward_apply_refused:arguments');
 return 'apply';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 Promise.resolve().then(()=>runCatalogForwardCustodied(catalogApplyArguments(process.argv.slice(2)))).catch(e=>{
  console.error(/^catalog_forward_(?:rollback|apply)_refused:/.test(e?.message??'')?e.message:'catalog_forward_apply_failed');process.exitCode=1;
 });
