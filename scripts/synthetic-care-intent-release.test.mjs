import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P,sha256,careReleaseZip} from './synthetic-care-release.mjs';
import {INTENT_RELEASE,careIntentMigrationBinding,careIntentMobileBinding,createCareIntentCandidate,
 verifyCareIntentCandidate} from './synthetic-care-intent-release.mjs';
import {verifyCareIntentInspector,verifyCareIntentOperator} from './prepare-synthetic-care-intent-release.mjs';
const clone=structuredClone;
function current(){
 const snapshot={commit:'a'.repeat(40),clean:true,files:3,sha256:'b'.repeat(64)};
 return {desktop:snapshot,mobile:{source:{...snapshot,commit:'c'.repeat(40)},
  ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'d'.repeat(64)])),
  built:false,deviceVerified:false},migrations:careIntentMigrationBinding(process.cwd()),templateSha256:'e'.repeat(64)};
}
function candidate(){const c=current(),bundle=Buffer.from('exports.handler=async()=>({statusCode:503});');
 return {...createCareIntentCandidate(c,bundle),current:c};}
function inspection(c=current()){
 return {contract:'care-erasure-intent-upgrade/1',command:'inspect',operatorSource:{sourceCommit:c.desktop.commit,clean:true},
  awsAccountId:P.account,foundation:P.foundation,execution:'synthetic-staging',phiAllowed:false,
  observedMigrationCount:47,sourceMigrationCount:46,tableCount:88,rowCount:23985,dataSha256:'1'.repeat(64),schemaSha256:'2'.repeat(64),
  fromLedgerSha256:c.migrations.liveBefore,toLedgerSha256:c.migrations.liveAfter,referenceLedgerSha256:c.migrations.reference,
  dataPreserved:true,schemaPreserved:true,
  ...Object.fromEntries(['applied','alreadyApplied','rolledBack','canonicalRegistered','hostedAcceptance','recoveryAcceptance',
   'activationApproved','rollbackReadback','lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed','acceptance','phiActivation'].map(k=>[k,false]))};
}
test('separate artifact binds real unchanged parent and blocked overlay to matched app recovery sources',()=>{
 const c=candidate();verifyCareIntentCandidate(c.manifest,c.release,c.bundle,c.zip,c.current);
 assert.equal(c.manifest.contract,INTENT_RELEASE.contract);
 assert.equal(c.manifest.erasureProtocol,INTENT_RELEASE.protocol);
 assert.equal(c.manifest.migrations.canonicalRegistered,false);
 assert.equal(c.manifest.migrations.parent.sourceCount,46);
 assert.equal(c.manifest.migrations.liveBeforeCount,47);assert.equal(c.manifest.migrations.liveAfterCount,48);
 assert.match(c.manifest.key,/\/care-intent-release\//);
 assert.deepEqual(c.zip,careReleaseZip(c.bundle,c.release));
 assert.equal(c.manifest.rollout.lastingSchemaUpgradeAuthorized,false);
 assert.equal(c.manifest.rollback.parentApiAllowedAfterIntentUpgrade,false);
});
test('dirty sources, fabricated device verification, hashes and mismatched migration boundaries refuse creation',()=>{
 for(const change of [c=>c.desktop.clean=false,c=>c.mobile.source.clean=false,c=>c.mobile.built=true,
  c=>c.mobile.deviceVerified=true,c=>delete c.mobile.recoveryContractSha256,c=>c.mobile.recoveryUiSha256='invalid',
  c=>c.migrations.canonicalRegistered=true,c=>c.migrations.liveBefore=P.liveBefore,c=>c.migrations.sourceBefore=P.sourceBefore,
  c=>c.migrations.liveAfter='0'.repeat(64),c=>c.migrations.reference='0'.repeat(64),c=>c.migrations.liveBeforeCount=46,
  c=>c.migrations.sourceAfterCount=48,c=>c.migrations.tablesAfter=88]){
  const value=current();change(value);assert.throws(()=>createCareIntentCandidate(value,Buffer.from('handler')),/source_binding/);
 }
 assert.throws(()=>createCareIntentCandidate(current(),Buffer.alloc(0)),/bundle/);
});
test('rehashing edited code/release, wrong predecessor or any claimed activation cannot match actual source binding',()=>{
 const c=candidate();
 for(const change of [m=>m.desktop.commit='f'.repeat(40),m=>m.mobile.recoveryUiSha256='f'.repeat(64),
  m=>m.mobile.requestJournalSha256='f'.repeat(64),m=>m.mobile.recoveryContractSha256='f'.repeat(64),
  m=>m.predecessor.zip=P.previousZipSha256,m=>m.predecessor.version='other',m=>m.phiAllowed=true,
  m=>m.deployed=true,m=>m.hostedAcceptance=true,m=>m.schemaChanged=true,m=>m.phiActivation=true,
  m=>m.rollout.lastingSchemaUpgradeAuthorized=true,m=>m.rollout.newActionsUnavailableUntilSchema=false,
  m=>m.rollback.parentApiAllowedAfterIntentUpgrade=true,m=>m.rollback.rehearsed=true,
  m=>m.erasureProtocol='request-id-receipt-settlement/1',m=>m.key+='/extra',m=>m.extraAuthority=true]){
  const m=clone(c.manifest);change(m);
  assert.throws(()=>verifyCareIntentCandidate(m,c.release,c.bundle,c.zip,c.current),/candidate_bytes_or_binding/);
 }
 const edited=Buffer.from('edited handler'),release={...c.release,bundleSha256:sha256(edited)},zip=careReleaseZip(edited,release);
 const manifest={...c.manifest,...release,zipSha256:sha256(zip),zipBytes:zip.length};
 assert.throws(()=>verifyCareIntentCandidate(manifest,release,c.bundle,zip,c.current));
 assert.throws(()=>verifyCareIntentCandidate(c.manifest,c.release,c.bundle,Buffer.concat([c.zip,Buffer.from('suffix')]),c.current));
});
test('live preflight admits only exact parent ledger and honest read-only independent inspector',()=>{
 const c=current(),r=inspection(c);assert.deepEqual(verifyCareIntentInspector(r,c),r);
 for(const change of [r=>r.awsAccountId='173535830222',r=>r.foundation+='-qualification',r=>r.execution='qualification',
  r=>r.operatorSource.sourceCommit='f'.repeat(40),r=>r.operatorSource.clean=false,r=>r.command='upgrade',
  r=>r.observedMigrationCount=48,r=>r.sourceMigrationCount=47,r=>r.tableCount=89,r=>r.rowCount=-1,
  r=>r.dataSha256='missing',r=>r.schemaSha256='missing',r=>r.fromLedgerSha256=P.liveBefore,
  r=>r.toLedgerSha256=P.liveAfter,r=>r.dataPreserved=false,r=>r.schemaPreserved=false,
  ...['phiAllowed','applied','alreadyApplied','canonicalRegistered','hostedAcceptance','recoveryAcceptance','activationApproved',
   'lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed','acceptance','phiActivation'].map(k=>r=>r[k]=true),
  r=>delete r.lastingUpgradeAvailable]){
  const value=clone(r);change(value);assert.throws(()=>verifyCareIntentInspector(value,c),/database_predecessor/);
 }
});
test('the inspector itself must embed exact overlay and both ledgers at this clean source, with lasting CLI disabled',()=>{
 const c=current(),bytes=Buffer.from('exact embedded operator');
 const m={contract:'care-erasure-intent-operator-build/1',sourceCommit:c.desktop.commit,clean:true,sha256:sha256(bytes),
  execution:'synthetic-staging',phiAllowed:false,
  ...Object.fromEntries(['embeddedMigrations','embeddedReferenceMigrations','embeddedOverlay','inspectionAvailable','rollbackRehearsalAvailable','apiRecoveryRequired'].map(k=>[k,true])),
  ...Object.fromEntries(['targetOverrides','lastingUpgradeAvailable','canonicalRegistered','migrationPerformed','hostedAcceptance'].map(k=>[k,false])),
  releaseMapping:{migration:c.migrations.overlay,liveBeforeCount:47,liveAfterCount:48,
   liveBeforeSha256:c.migrations.liveBefore,liveAfterSha256:c.migrations.liveAfter}};
 verifyCareIntentOperator(m,bytes,c);
 for(const change of [m=>m.sourceCommit='f'.repeat(40),m=>m.clean=false,m=>m.embeddedOverlay=false,
  m=>m.lastingUpgradeAvailable=true,m=>m.targetOverrides=true,m=>m.apiRecoveryRequired=false,
  m=>m.releaseMapping.migration.sha256='f'.repeat(64),m=>m.releaseMapping.liveBeforeCount=46,
  m=>m.releaseMapping.liveAfterSha256='f'.repeat(64),m=>m.canonicalRegistered=true]){
  const value=clone(m);change(value);assert.throws(()=>verifyCareIntentOperator(value,bytes,c),/inspector_binding/);
 }
 assert.throws(()=>verifyCareIntentOperator(m,Buffer.from('changed'),c));
});
test('app binding compares recovery contract bytes and includes UI, journal, transport and destination',t=>{
 const temp=mkdtempSync(resolve(tmpdir(),'alp intent mobile '));t.after(()=>rmSync(temp,{recursive:true,force:true}));
 const desktop=resolve(temp,'desktop'),mobile=resolve(temp,'mobile');
 mkdirSync(resolve(desktop,'src/contracts'),{recursive:true});
 for(const folder of ['contracts','components','lib/clinicalData'])mkdirSync(resolve(mobile,'expo',folder),{recursive:true});
 for(const name of ['careDataLifecycle','careErasureRecovery']){
  const bytes=readFileSync(resolve('src/contracts',name+'.ts'));
  writeFileSync(resolve(desktop,'src/contracts',name+'.ts'),bytes);writeFileSync(resolve(mobile,'expo/contracts',name+'.ts'),bytes);
 }
 writeFileSync(resolve(mobile,'expo/components/CareErasureRequestsList.tsx'),'export const Recovery = 1;\n');
 for(const name of ['careErasureJournal','awsCareDataLifecycle'])writeFileSync(resolve(mobile,'expo/lib/clinicalData',name+'.ts'),'export const safe = 1;\n');
 const env={EXPO_PUBLIC_RELEASE_CHANNEL:'synthetic-testflight',EXPO_PUBLIC_SYNTHETIC_ACCOUNT_DOMAIN:'brightlongevity.test',
  EXPO_PUBLIC_CLINICAL_AWS_API_ORIGIN:`https://${P.apiId}.execute-api.${P.region}.amazonaws.com`,EXPO_PUBLIC_CLINICAL_AWS_RUNTIME_MODE:'synthetic',
  EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_POOL_ID:P.consumerPool,EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_CLIENT_ID:P.consumerClient};
 writeFileSync(resolve(mobile,'expo/eas.json'),JSON.stringify({build:{testflight:{env},'android-health-connect':{env}}}));
 const git=args=>execFileSync('git',args,{cwd:mobile,windowsHide:true,stdio:['ignore','pipe','pipe']});
 git(['init']);git(['add','.']);git(['-c','user.name=Fictional','-c','user.email=fictional@example.invalid',
  '-c','commit.gpgsign=false','commit','--no-verify','-m','fixture']);
 const binding=careIntentMobileBinding(mobile,desktop);
 assert.equal(binding.built,false);assert.equal(binding.deviceVerified,false);assert.match(binding.recoveryUiSha256,/^[a-f0-9]{64}$/);
 writeFileSync(resolve(mobile,'expo/contracts/careErasureRecovery.ts'),'different');
 assert.throws(()=>careIntentMobileBinding(mobile,desktop),/source_dirty/);
 git(['add','.']);git(['-c','user.name=Fictional','-c','user.email=fictional@example.invalid',
  '-c','commit.gpgsign=false','commit','--no-verify','-m','different clean contract']);
 assert.throws(()=>careIntentMobileBinding(mobile,desktop),/recovery_contract/);
});
test('read-only command rebuilds actual source and independently re-observes live state with no deployment or upgrade operation',()=>{
 const source=readFileSync(new URL('./prepare-synthetic-care-intent-release.mjs',import.meta.url),'utf8');
 assert.match(source,/buildCareIdentityBundle\(root\)/);
 assert.match(source,/const before=inspect\(\),live=control\(\)/);
 assert.match(source,/const after=inspect\(\),returned=control\(\)/);
 assert.match(source,/GetObjectCommand\(input\)/);
 assert.match(source,/verifyCareStoredArtifact\(object/);
 assert.match(source,/readCareArtifact\(object.Body/);
 assert.doesNotMatch(source,/'upgrade'|--confirm|create-change-set|execute-change-set|update-function|PutObjectCommand/);
 const operator=readFileSync(new URL('../src/server/clinical-core/care-erasure-intent-operator.ts',import.meta.url),'utf8');
 assert.match(operator,/keepAlive:false,maxSockets:1/);
 assert.match(operator,/connectionTimeout:10000,requestTimeout:30000/);
 assert.match(operator,/maxAttempts:1/);assert.match(operator,/createCareErasureOperatorClient\(client\)/);
 assert.match(operator,/finally\(\(\)=>\{client\?\.destroy\(\)/);
 assert.doesNotMatch(operator,/error\.message|error\.stack|console\.(?:log|error)\(error\)/);
});
