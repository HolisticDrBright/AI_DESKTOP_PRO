import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './synthetic-care-release.mjs';
import {catalogRuntimeExecutionArguments,saveCatalogExecutionEvidence,readCatalogExecutionEvidence} from './catalog-runtime-execution-live.mjs';
const args=['--v2-root','v2','--artifact','artifact','--custody-root','custody','--deployed-desktop-root','old-desktop',
 '--deployed-v2-root','old-mobile','--application-root','application','--execute-fictional-catalog-runtime-code-only'];
test('both commands require exact six path pairs and refuse target, report, provider, approval and build overrides',()=>{
 assert.equal(catalogRuntimeExecutionArguments(args).applicationRoot,resolve('application'));
 const reconcile=[...args];reconcile[12]='--reconcile-fictional-catalog-runtime-execution-only';
 assert.equal(catalogRuntimeExecutionArguments(reconcile,true).directory,resolve('artifact'));
 for(const mutate of [a=>a.push('--approve'),a=>a.splice(10,2),a=>a[0]='--target',a=>a[1]='--profile',a=>a[12]='--execute',
  a=>a[10]='--report',a=>a[8]='--production',a=>a[11]='']){const a=[...args];mutate(a);assert.throws(()=>catalogRuntimeExecutionArguments(a));}
 assert.throws(()=>catalogRuntimeExecutionArguments(args,true));assert.throws(()=>catalogRuntimeExecutionArguments(reconcile));
});
test('local witnesses are create-only, byte-exact, size bounded and restricted to their operation directory',()=>{
 const directory=mkdtempSync(resolve(tmpdir(),'alp-catalog-execution-evidence-'));
 try{
  const bytes=Buffer.from(JSON.stringify({fictional:true},null,2)+'\n'),file=resolve(directory,'before-'+sha256(bytes)+'.json');
  assert.equal(saveCatalogExecutionEvidence(file,bytes),sha256(bytes));assert.equal(saveCatalogExecutionEvidence(file,bytes),sha256(bytes));
  assert(readCatalogExecutionEvidence(directory,file,'before').equals(bytes));
  assert.throws(()=>saveCatalogExecutionEvidence(file,Buffer.from('changed')));assert(readFileSync(file).equals(bytes));
  assert.throws(()=>readCatalogExecutionEvidence(resolve(directory,'other'),file,'before'));
  assert.throws(()=>readCatalogExecutionEvidence(directory,file,'admission'));
  assert.throws(()=>readCatalogExecutionEvidence(directory,file,'unknown'));
  const oversized=resolve(directory,'too-large.json');assert.throws(()=>saveCatalogExecutionEvidence(oversized,Buffer.alloc(2*1024*1024+1)));
  assert.equal(existsSync(oversized),false);
 }finally{assert(directory.startsWith(resolve(tmpdir(),'alp-catalog-execution-evidence-')));rmSync(directory,{recursive:true,force:true});}
});
test('public execution constructs actual fixed observers and exposes no proposal/upload, schema, activation or route write',()=>{
 const text=readFileSync(new URL('./catalog-runtime-execution-live.mjs',import.meta.url),'utf8');
 assert.match(text,/verifyCatalogRuntimeOperatorApplication/);assert.match(text,/observeCatalogRuntimePreflight/);
 assert.match(text,/observeCatalogRuntimeControlRaw/);assert.match(text,/buildCareRegisteredDatabaseObserver/);
 assert.match(text,/downloadIntentFunction/);assert.match(text,/inspectRegisteredUploadObject/);
 assert.match(text,/createIntentUploadCustody\(options\.custodyRoot,out,c\.current,'catalog-runtime-artifact-execution'\)/);
 assert.match(text,/verifyCatalogRuntimeBeforeExecution\(before/);assert.match(text,/publication_changed/);
 assert.equal((text.match(/'execute-change-set'/g)??[]).length,1);
 assert.doesNotMatch(text,/create-change-set|delete-change-set|update-integration|add-permission|PutObjectCommand|migrate|PhiAllowed|Activation|eas build/);
 const reconcile=text.slice(text.indexOf('export async function reconcileCatalogRuntimeExecutionLive'));
 assert.doesNotMatch(reconcile,/execute-change-set|create-change-set|delete-change-set|update-integration/);
 assert.match(reconcile,/stoppedUploadWriter/);assert.match(reconcile,/archive/);assert.match(reconcile,/unlinkSync\(lock\)/);
});
