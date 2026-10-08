import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,cpSync,symlinkSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {CARE_RELEASE as P,sha256,careReleaseZip} from './synthetic-care-release.mjs';
import {canonicalCareRegistrationDescriptor,readCanonicalCareMigrations} from './care-canonical-migrations.mjs';
import {CARE_REGISTERED,careRegisteredTarget,assertCareRegisteredCurrent,createCareRegisteredCandidate,
 verifyCareRegisteredCandidate,buildCareRegisteredCandidate,writeCareRegisteredCandidate,readCareRegisteredCandidate,
 inspectCareRegisteredArtifact,careRegisteredCurrent} from './synthetic-care-registered-release.mjs';
import {careRegisteredBuildArguments,runCareRegisteredBuild} from './build-synthetic-care-registered-release.mjs';
import {careRegisteredInspectArguments} from './inspect-synthetic-care-registered-artifact.mjs';
const hash='b'.repeat(64),bundle=Buffer.from('exports.handler=async()=>({statusCode:403});\n');
function dispose(root){
 assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('alp-registered-'));
 rmSync(root,{recursive:true,force:true});
}
function current(){return {desktop:{commit:'a'.repeat(40),clean:true,files:10,sha256:hash},
 mobile:{source:{commit:'c'.repeat(40),clean:true,files:11,sha256:'d'.repeat(64)},built:false,deviceVerified:false,
  ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,hash]))},
 migrations:canonicalCareRegistrationDescriptor(),templateSha256:'e'.repeat(64)};}
test('registered descriptor still equals every actual current source migration and reference hash',()=>{
 assert.deepEqual(canonicalCareRegistrationDescriptor(),readCanonicalCareMigrations(process.cwd()).mapping);
});
test('deterministic current artifact binds both sources, exact registered history and current predecessor; not acceptance',()=>{
 const c=createCareRegisteredCandidate(current(),bundle),again=createCareRegisteredCandidate(current(),bundle);
 assert(c.zip.equals(again.zip));assert(c.zip.equals(careReleaseZip(bundle,c.release)));
 assert.equal(c.release.contract,CARE_REGISTERED.contract);assert.equal(c.release.target.account,'588966314750');
 assert.equal(c.release.migrations.sourceMigrationCount,47);assert.equal(c.release.migrations.liveMigrationCount,48);
 assert.equal(c.manifest.zipSha256,sha256(c.zip));assert.equal(c.manifest.bundleSha256,sha256(bundle));
 assert(c.manifest.key.includes(current().desktop.commit+'/'+current().mobile.source.commit+'/'+c.manifest.zipSha256));
 assert.equal(c.release.predecessor.zipSha256,CARE_REGISTERED.predecessorZip);
 assert.equal(c.release.predecessor.liveObservationSupplied,false);assert.deepEqual(c.release.rollout.knownAbsentSourceRoutes,P.absentRoutes);
 for(const key of ['deployed','schemaChanged','hostedAcceptance','erasureAccepted','physicalDeviceAcceptance','matchedReleaseAccepted',
  'productionApproved','phiActivation','releaseExecutionAvailable','paidMobileBuildStarted','phiAllowed'])assert.equal(c.release[key],false);
 for(const key of ['schemaReplayAllowed','ledgerRewriteAllowed','authorityExpansionAllowed','missingRoutesAdded'])assert.equal(c.release.rollout[key],false);
 assert.equal(verifyCareRegisteredCandidate(c,current()).sourceRebuilt,false);
});
test('old parent, rewritten registered history, extra authority and claimed mobile/device builds refuse',()=>{
 const changes=[c=>{c.migrations.canonicalRegistered=false;},c=>{c.migrations.sourceMigrationCount=46;},
  c=>{c.migrations.liveMigrationCount=47;},c=>{c.migrations.liveLedgerSha256=hash;},c=>{c.migrations.referenceLedgerSha256=hash;},
  c=>{c.migrations.migration.sha256=hash;},c=>{c.migrations.phiAllowed=true;},c=>{c.migrations.productionApproved=true;},
  c=>{c.migrations.schemaReplayAuthorized=true;},c=>{c.migrations.reviewed=true;},
  c=>{c.mobile.built=true;},c=>{c.mobile.deviceVerified=true;},c=>{c.mobile.recoveryUiSha256='';},
  c=>{c.desktop.clean=false;},c=>{c.desktop.commit='HEAD';},c=>{c.desktop.files=0;},c=>{c.desktop.sha256='missing';},
  c=>{c.templateSha256='';},c=>{c.target={account:'173535830222'};}];
 for(const change of changes){const c=current();change(c);assert.throws(()=>assertCareRegisteredCurrent(c),/refused/);}
});
test('manifest, embedded release, zip, source and authority substitutions all refuse',()=>{
 for(const change of [c=>{c.manifest.key='other.zip';},c=>{c.release.phiAllowed=true;},c=>{c.manifest.target.database='clinical_core_qualification';},
  c=>{c.manifest.predecessor.version='other';},c=>{c.manifest.acceptanceRequirements=[];},c=>{c.release.deployed=true;},
  c=>{c.release.acceptanceRequirements.push('invented_pass');},c=>{c.manifest.mobile.source.commit='f'.repeat(40);},
  c=>{c.bundle=Buffer.from('altered');},c=>{c.zip=Buffer.from('altered');}]){
  const c=createCareRegisteredCandidate(current(),bundle);change(c);assert.throws(()=>verifyCareRegisteredCandidate(c,current()),/refused/);
 }
});
test('writer is immutable and idempotent; corrupt collisions stay unchanged and unknown files refuse',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-artifact-'));
 try{const c=createCareRegisteredCandidate(current(),bundle),dir=writeCareRegisteredCandidate(root,c);
  assert.equal(writeCareRegisteredCandidate(root,c),dir);verifyCareRegisteredCandidate(readCareRegisteredCandidate(dir),current());
  writeFileSync(resolve(dir,'index.js'),'corrupt');
  assert.throws(()=>writeCareRegisteredCandidate(root,c),/artifact_collision/);assert.equal(readFileSync(resolve(dir,'index.js'),'utf8'),'corrupt');
  writeFileSync(resolve(dir,'index.js'),bundle);writeFileSync(resolve(dir,'approval.json'),'{}');
  assert.throws(()=>readCareRegisteredCandidate(dir),/artifact_layout/);
 }finally{dispose(root);}
});
test('bounded readers refuse oversized JSON instead of accepting a supplied report',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-bounds-'));
 try{const dir=writeCareRegisteredCandidate(root,createCareRegisteredCandidate(current(),bundle));
  writeFileSync(resolve(dir,'release.json'),' '.repeat(256*1024+1));assert.throws(()=>readCareRegisteredCandidate(dir),/artifact_json/);
 }finally{dispose(root);}
});
test('metadata bytes must match the ZIP binding; formatting and duplicate flags do not silently normalize away',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-metadata-'));
 try{const c=createCareRegisteredCandidate(current(),bundle),dir=writeCareRegisteredCandidate(root,c);
  for(const bytes of [Buffer.from(JSON.stringify(c.release,null,2)+'\n'),
   Buffer.from(c.releaseBytes.toString('utf8').replace('{','{"phiAllowed":true,'))]){
   writeFileSync(resolve(dir,'release.json'),bytes);
   assert.throws(()=>verifyCareRegisteredCandidate(readCareRegisteredCandidate(dir),current()),/candidate_binding/);
  }
 }finally{dispose(root);}
});
test('an artifact parent junction or symlink is refused and its destination remains untouched',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-link-')),other=mkdtempSync(resolve(tmpdir(),'alp-registered-destination-'));
 try{writeFileSync(resolve(other,'marker'),'unchanged');symlinkSync(other,resolve(root,'dist'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>writeCareRegisteredCandidate(root,createCareRegisteredCandidate(current(),bundle)),/artifact_directory/);
  assert.equal(readFileSync(resolve(other,'marker'),'utf8'),'unchanged');
 }finally{dispose(root);dispose(other);}
});
test('build and local inspection parsers have no target, approval, report, upload or paid-build switches',()=>{
 for(const args of [[],['--v2-root'],['--v2-root','--report=pass.json'],['--v2-root','.','--phi=true'],
  ['--v2-root','.','--upload'],['--v2-root','.','--historical-source-only']])assert.throws(()=>careRegisteredBuildArguments(args),/arguments/);
 for(const args of [[],['--v2-root','.','--report','pass.json'],['--v2-root','.','--artifact','--approved'],
  ['--v2-root','.','--artifact','.','--profile=prod']])assert.throws(()=>careRegisteredInspectArguments(args),/arguments/);
 assert.equal(careRegisteredTarget().database,'clinical_core');assert.equal(careRegisteredTarget().phiAllowed,false);
});
function pair(){
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-pair-')),desktop=resolve(root,'desktop'),mobile=resolve(root,'mobile');
 mkdirSync(desktop);mkdirSync(mobile);
 const source=process.cwd(),copy=(to,from)=>{mkdirSync(resolve(to,from,'..'),{recursive:true});cpSync(resolve(source,from),resolve(to,from),{recursive:true});};
 for(const folder of ['infra/aws-clinical-core/migrations','infra/aws-clinical-core/catalog-migrations','infra/aws-clinical-core/source-candidates'])copy(desktop,folder);
 for(const file of ['src/contracts/careDataLifecycle.ts','src/contracts/careErasureRecovery.ts','infra/aws-clinical-core/identity-api-extension.json'])copy(desktop,file);
 mkdirSync(resolve(desktop,'src/server/clinical-core'),{recursive:true});writeFileSync(resolve(desktop,'src/server/clinical-core/aws-identity-lambda.ts'),bundle);
 const put=(file,bytes)=>{mkdirSync(resolve(mobile,file,'..'),{recursive:true});writeFileSync(resolve(mobile,file),bytes);};
 put('expo/contracts/careDataLifecycle.ts',readFileSync(resolve(source,'src/contracts/careDataLifecycle.ts')));
 put('expo/contracts/careErasureRecovery.ts',readFileSync(resolve(source,'src/contracts/careErasureRecovery.ts')));
 for(const file of ['expo/lib/clinicalData/careErasureJournal.ts','expo/lib/clinicalData/awsCareDataLifecycle.ts','expo/components/CareErasureRequestsList.tsx'])put(file,'// fictional source fixture\n');
 const env={EXPO_PUBLIC_RELEASE_CHANNEL:'synthetic-testflight',EXPO_PUBLIC_SYNTHETIC_ACCOUNT_DOMAIN:'brightlongevity.test',
  EXPO_PUBLIC_CLINICAL_AWS_API_ORIGIN:`https://${P.apiId}.execute-api.${P.region}.amazonaws.com`,EXPO_PUBLIC_CLINICAL_AWS_RUNTIME_MODE:'synthetic',
  EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_POOL_ID:P.consumerPool,EXPO_PUBLIC_CLINICAL_AWS_CONSUMER_CLIENT_ID:P.consumerClient};
 put('expo/eas.json',JSON.stringify({build:{testflight:{env},'android-health-connect':{env}}}));
 const git=(dir,args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe',windowsHide:true});
 for(const dir of [desktop,mobile]){git(dir,['init']);git(dir,['config','user.name','Fictional qualification']);git(dir,['config','user.email','fixture@brightlongevity.test']);
  git(dir,['add','.']);git(dir,['commit','-m','fictional source fixture']);}
 return {root,desktop,mobile,put,git};
}
test('real paired clean-source builder and independent rebuild pass without any AWS or mobile operation',async()=>{
 const p=pair();try{const c=await buildCareRegisteredCandidate(p.desktop,p.mobile),dir=writeCareRegisteredCandidate(p.desktop,c);
  const r=await inspectCareRegisteredArtifact(p.desktop,p.mobile,dir);assert.equal(r.sourceRebuilt,true);assert.equal(r.liveTargetObserved,false);
  assert.equal(r.releaseAccepted,false);assert.equal(r.phiAllowed,false);assert.equal(r.paidMobileBuildStarted,false);
  const cli=await runCareRegisteredBuild(p.desktop,['--v2-root',p.mobile]);assert.equal(cli.directory,dir);
 }finally{dispose(p.root);}
});
test('a consistently rehashed invented bundle passes only byte checks and fails the actual source rebuild',async()=>{
 const p=pair();try{const c=createCareRegisteredCandidate(careRegisteredCurrent(p.desktop,p.mobile),Buffer.from('exports.handler=()=>"invented";'));
  verifyCareRegisteredCandidate(c,c.current);const dir=writeCareRegisteredCandidate(p.desktop,c);
  await assert.rejects(inspectCareRegisteredArtifact(p.desktop,p.mobile,dir),/rebuilt_bundle/);
 }finally{dispose(p.root);}
});
test('dirty source and committed cross-app/destination drift refuse before a candidate can be built',async()=>{
 const p=pair();try{
  p.put('expo/lib/clinicalData/awsCareDataLifecycle.ts','// changed');
  await assert.rejects(buildCareRegisteredCandidate(p.desktop,p.mobile),/source_dirty/);
  p.git(p.mobile,['add','.']);p.git(p.mobile,['commit','-m','changed fixture']);
  p.put('expo/contracts/careErasureRecovery.ts','// wrong contract');p.git(p.mobile,['add','.']);p.git(p.mobile,['commit','-m','wrong contract']);
  await assert.rejects(buildCareRegisteredCandidate(p.desktop,p.mobile),/recovery_contract/);
  p.put('expo/contracts/careErasureRecovery.ts',readFileSync(resolve(process.cwd(),'src/contracts/careErasureRecovery.ts')));
  const eas=JSON.parse(readFileSync(resolve(p.mobile,'expo/eas.json'),'utf8'));eas.build.testflight.env.EXPO_PUBLIC_CLINICAL_AWS_PRODUCTION_VERIFIED='true';
  p.put('expo/eas.json',JSON.stringify(eas));p.git(p.mobile,['add','.']);p.git(p.mobile,['commit','-m','unsafe destination']);
  await assert.rejects(buildCareRegisteredCandidate(p.desktop,p.mobile),/mobile_destination/);
 }finally{dispose(p.root);}
});
