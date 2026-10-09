import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {registeredReleaseArguments} from './release-synthetic-care-registered.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {careRegisteredDeploymentFixture} from './test-fixtures/care-registered-deployment.mjs';
test('public live command takes only two source paths and the exact synthetic recovery operation',()=>{
 const flag='--release-fictional-registered-with-fresh-recovery',good=['--v2-root','V2','--artifact','artifact',flag];
 assert.deepEqual(registeredReleaseArguments(good),{mobileRoot:resolve('V2'),directory:resolve('artifact')});
 for(const a of [[],good.slice(0,4),[...good,'--approve'],[...good,'--phi'],[...good,'--profile','production'],
  [...good,'--report','saved'],[...good,'--skip-recovery'],[...good,'--migration'],[...good,'--paid-build'],
  good.map((v,i)=>i===1?'':v),good.map((v,i)=>i===3?'--target':v)])assert.throws(()=>registeredReleaseArguments(a));
});
test('release purpose holds unknown execution under the same exclusive operator lock and verifies its exact identity',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-live-'));try{
  const current=careRegisteredDeploymentFixture().current,custody=createIntentUploadCustody(root,resolve(root,'operations'),current,'registered-artifact-upload-release');
  custody.verify();assert.equal(JSON.parse(readFileSync(custody.lock,'utf8')).purpose,'registered-artifact-upload-release');
  custody.admit({stage:'registered_change_execute_admitted'});custody.close();assert.equal(existsSync(custody.lock),true);
  assert.throws(()=>createIntentUploadCustody(root,resolve(root,'operations'),current,'registered-artifact-upload-release'));
  writeFileSync(custody.lock,'{}\n');assert.throws(()=>custody.verify(),/custody_changed/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('live sequence uses its own service observations, archives before admission, executes once and requires actual recovery',()=>{
 const text=readFileSync(new URL('./release-synthetic-care-registered.mjs',import.meta.url),'utf8');
 assert.match(text,/proposeCareRegisteredLive\(root,c,mobileRoot,directory\)/);assert.match(text,/observeCareRegisteredPreflight\(root,mobileRoot,directory\)/);
 assert.match(text,/database=buildCareRegisteredDatabaseObserver/);assert.match(text,/inspectRegisteredUploadObject\(candidate/);
 assert.match(text,/save\(file,admission\);await c\.admit/);assert.match(text,/before:savedBefore/);
 assert.match(text,/runCareRegisteredLiveRecovery\(root,mobileRoot/);assert.match(text,/verifyCareRegisteredDeployment\(witness/);
 assert.match(text,/AWS_MAX_ATTEMPTS:'1'/);assert.match(text,/finally\{client.destroy\(\);\}/);
 assert.equal((text.match(/'execute-change-set'/g)??[]).length,1);
 assert.doesNotMatch(text,/update-function-code|publish-version|action:'erase'|action:'prepare_erasure'|--report|--skip-recovery|--phi/);
 assert.match(text,/hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false/);
});
