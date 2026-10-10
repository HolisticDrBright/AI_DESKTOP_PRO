import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
import {CARE_RELEASE as P,sha256,careReleaseZip} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,verifyCareRegisteredCandidate,readCareRegisteredCandidate} from './synthetic-care-registered-release.mjs';
import {CATALOG_RUNTIME as K,catalogRuntimePredecessor,catalogRuntimeRecoveryPredecessor,createCatalogRuntimeCandidate,
 verifyCatalogRuntimeCandidate,writeCatalogRuntimeCandidate} from './synthetic-catalog-runtime-release.mjs';
import {catalogRuntimePredecessorTemplate,verifyCatalogRuntimePredecessorControl,verifyCatalogRuntimeRecoveryFunction,
 runCatalogRuntimePreflight} from './catalog-runtime-preflight.mjs';
import {verifyCareRegisteredPredecessorControl} from './care-registered-preflight.mjs';
import {careRegisteredControlFixture} from './test-fixtures/care-registered-control.mjs';
import {careRegisteredDatabaseFixture} from './test-fixtures/care-registered-database.mjs';
import {catalogRuntimeInspectArguments,catalogRuntimeObservationEnvironment} from './inspect-synthetic-catalog-runtime-release.mjs';
import {canonical,CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
function fixture(){
 const f=careRegisteredControlFixture(),oldRaw=structuredClone(f.raw);
 const candidate=createCatalogRuntimeCandidate(f.current,f.candidate.bundle);
 // Fictional transport only: this fixture manufactures the new fixed deployed
 // profile. The public observer never patches or manufactures raw AWS data.
 f.raw.template=catalogRuntimePredecessorTemplate(f.source);
 f.raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=catalogRuntimePredecessor().key;
 f.raw.fn.CodeSha256=Buffer.from(K.predecessorZip,'hex').toString('base64');f.raw.fn.CodeSize=K.predecessorBytes;
 const recovery={configuration:{...structuredClone(f.raw.fn),FunctionArn:R.latestArn+':2',Version:'2',
  CodeSha256:Buffer.from(C.predecessorZip,'hex').toString('base64'),CodeSize:C.predecessorBytes},
  sha256:C.predecessorZip,bytes:C.predecessorBytes,policy:null};
 const local={...verifyCatalogRuntimeCandidate(candidate,f.current),sourceRebuilt:true,desktopCommit:f.current.desktop.commit,
  mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,erasureAccepted:false,
  physicalDeviceAcceptance:false,paidMobileBuildStarted:false};
 const downloads={managedSha256:K.predecessorZip,managedBytes:K.predecessorBytes,storedSha256:K.predecessorZip,
  storedBytes:K.predecessorBytes,version:K.predecessorVersion,exactBytesVerified:true,frozenSourceRebuilt:true};
 const caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fixture'};
 const db=careRegisteredDatabaseFixture(f.current,f.now),calls=[];let clock=f.now;
 const port={sourceText:f.sourceText,now:()=>clock,
  rebuild:async()=>{calls.push('rebuild');return structuredClone(local);},
  current:async()=>{calls.push('current');return structuredClone(f.current);},
  identity:async()=>{calls.push('identity');return structuredClone(caller);},
  database:async()=>{calls.push('database');return structuredClone(db);},
  control:async()=>{calls.push('control');return structuredClone(f.raw);},
  downloads:async()=>{calls.push('downloads');return structuredClone(downloads);},
  retained:async()=>{calls.push('retained');return structuredClone(recovery);}};
 return {...f,candidate,oldRaw,local,downloads,recovery,caller,db,port,calls,advance:ms=>{clock+=ms;}};
}
const run=f=>runCatalogRuntimePreflight(f.candidate,f.current,f.source,f.port);
function dispose(root){
 assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('alp-catalog-runtime-'));
 rmSync(root,{recursive:true,force:true});
}
test('new candidate is deterministic and names latest and recovery separately without claiming deployment',()=>{
 const f=fixture(),again=createCatalogRuntimeCandidate(f.current,f.candidate.bundle);
 assert(f.candidate.zip.equals(again.zip));assert(f.candidate.zip.equals(careReleaseZip(f.candidate.bundle,f.candidate.release)));
 assert.equal(f.candidate.manifest.zipSha256,sha256(f.candidate.zip));
 assert.equal(f.candidate.release.contract,K.contract);assert.deepEqual(f.candidate.release.predecessor,catalogRuntimePredecessor());
 assert.deepEqual(f.candidate.release.recoveryPredecessor,catalogRuntimeRecoveryPredecessor());
 assert.notEqual(f.candidate.release.predecessor.zipSha256,f.candidate.release.recoveryPredecessor.zipSha256);
 assert(f.candidate.manifest.key.includes('/catalog-runtime-release/'));
 assert.equal(f.candidate.release.migrations.referenceMigrationCount,3);
 for(const key of ['deployed','schemaChanged','hostedAcceptance','erasureAccepted','physicalDeviceAcceptance','matchedReleaseAccepted',
  'productionApproved','phiActivation','releaseExecutionAvailable','paidMobileBuildStarted','phiAllowed'])assert.equal(f.candidate.release[key],false);
 assert.equal(f.candidate.release.rollout.sameTargetCatalogAcceptanceRequired,true);
 assert.equal(f.candidate.release.rollout.ownerAdoptedPlanInventoryRequired,true);
 assert.throws(()=>verifyCareRegisteredCandidate(f.candidate,f.current));
});
test('candidate substitutions, approvals, extra flags, metadata reformatting and renamed recovery refuse',()=>{
 const changes=[c=>{c.manifest.predecessor.zipSha256=C.predecessorZip;},c=>{c.release.recoveryPredecessor.version='3';},
  c=>{c.release.predecessor.liveObservationSupplied=true;},c=>{c.manifest.target.account='173535830222';},
  c=>{c.release.deployed=true;},c=>{c.release.acceptanceRequirements=[];},c=>{c.release.approved=false;},
  c=>{c.release.rollout.sameTargetCatalogAcceptanceRequired=false;},c=>{c.release.mobile.deviceVerified=true;},
  c=>{c.releaseBytes=Buffer.from(JSON.stringify(c.release,null,2)+'\n');},c=>{c.zip=Buffer.from('invented');}];
 for(const change of changes){const f=fixture();change(f.candidate);assert.throws(()=>verifyCatalogRuntimeCandidate(f.candidate,f.current));}
});
test('both fixed control profiles refuse the other predecessor, checking raw observations without rewriting',()=>{
 const f=fixture(),saved=structuredClone(f.raw);
 const proof=verifyCatalogRuntimePredecessorControl(f.raw,f.source);
 assert.equal(proof.codeSha256,Buffer.from(K.predecessorZip,'hex').toString('base64'));
 assert.deepEqual(f.raw,saved);assert.equal(proof.identityRouteCount,51);assert.equal(proof.apiRouteCount,112);
 assert.throws(()=>verifyCareRegisteredPredecessorControl(f.raw,f.source));
 verifyCareRegisteredPredecessorControl(f.oldRaw,f.source);
 assert.throws(()=>verifyCatalogRuntimePredecessorControl(f.oldRaw,f.source));
});
test('complete live profile still refuses template, JWT, IAM, pagination, target and PHI drift',()=>{
 const changes=[o=>{o.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion=C.predecessorVersion;},
  o=>{o.stack.Stacks[0].Parameters.find(x=>x.ParameterKey==='DatabaseName').ParameterValue='clinical_core_qualification';},
  o=>{o.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS';},o=>{o.routes.NextToken='more';},
  o=>{o.routes.Items[0].AuthorizationType='NONE';},o=>{o.resources.StackResources.pop();},
  o=>{o.integrations.Items.find(x=>x.IntegrationId===R.integrationId).IntegrationUri=R.latestArn+':2';},
  o=>{o.policies[0].PolicyDocument.Statement[0].Resource='*';},o=>{o.fn.Environment.Variables.PHI_ALLOWED='true';},
  o=>{o.fn.CodeSize--;},o=>{o.fn.Version='2';},o=>{o.fn.FunctionArn+=':2';}];
 for(const change of changes){const f=fixture();change(f.raw);assert.throws(()=>verifyCatalogRuntimePredecessorControl(f.raw,f.source));}
});
test('recovery is actual retained version2, never asserted to equal latest bytes or granted an invoke policy',async()=>{
 const f=fixture();verifyCatalogRuntimeRecoveryFunction(f.recovery.configuration);
 const report=await run(f);assert.equal(report.retained.sameArtifactAsLatest,false);assert.equal(report.retained.version,'2');
 assert.equal(report.retained.sha256,C.predecessorZip);assert.equal(report.predecessorDownload.managedSha256,K.predecessorZip);
 for(const change of [r=>{r.configuration.CodeSha256=Buffer.from(K.predecessorZip,'hex').toString('base64');},
  r=>{r.configuration.Version='1';},r=>{r.configuration.FunctionArn=R.latestArn;},r=>{r.policy={Policy:'{}'};},
  r=>{r.sha256=K.predecessorZip;}]){
  const x=fixture();change(x.recovery);await assert.rejects(run(x));
 }
});
test('successful fictional preflight uses every repeated observer but grants no deployment, PHI or feature acceptance',async()=>{
 const f=fixture(),r=await run(f);assert.equal(r.contract,'synthetic-catalog-runtime-preflight/1');
 for(const call of ['database','control','retained','identity'])assert.equal(f.calls.filter(x=>x===call).length,2);
 for(const key of ['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted',
  'hostedAcceptance','releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(r[key],false);
 assert.equal(r.reportIsNotAuthority,true);assert.equal(r.repeatedReadbackVerified,true);
});
test('missing source rebuild, historical database, approval flags and unfrozen download witnesses refuse',async()=>{
 for(const change of [f=>{f.local.sourceRebuilt=false;},f=>{f.local.hostedAcceptance=true;},f=>{f.local.reviewed=false;},
  f=>{f.db.referenceMigrationCount=2;},f=>{f.db.phiAllowed=true;},f=>{f.db.operatorSource.sourceCommit='f'.repeat(40);},
  f=>{f.db.observedAt=new Date(f.now-1).toISOString();},f=>{f.downloads.frozenSourceRebuilt=false;},
  f=>{f.downloads.storedSha256=C.predecessorZip;},f=>{f.downloads.approved=false;},f=>{f.caller.Account='173535830222';}]){
  const f=fixture();change(f);await assert.rejects(run(f),undefined,change.toString());
 }
});
test('mutating supplied source/candidate while awaiting a rebuild cannot change the captured witnesses',async()=>{
 const f=fixture();f.port.rebuild=async()=>{
  f.current.mobile.deviceVerified=true;f.candidate.zip.fill(0);f.source.Resources.IdentityApiFunction.Properties.Timeout=30;
  return structuredClone(f.local);
 };
 await assert.rejects(run(f),/source_changed/);
 // Candidate substitution cannot survive even if current() returns the captured
 // source: the captured candidate was byte-verified before the await.
 const x=fixture(),original=structuredClone(x.current);
 x.port.rebuild=async()=>{x.candidate.zip.fill(0);return structuredClone(x.local);};x.port.current=async()=>original;
 assert.equal((await run(x)).candidateZipSha256,x.candidate.manifest.zipSha256);
});
test('second control/database/retained/principal observations cannot be replaced by a stale first success',async()=>{
 for(const name of ['control','database','retained','identity']){
  const f=fixture(),original=f.port[name];let count=0;
  f.port[name]=async()=>{const result=await original();if(++count===2){
   if(name==='control')result.fn.RevisionId='drift';
   if(name==='database')result.catalogInspection.rowCount++;
   if(name==='retained')result.configuration.RevisionId='drift';
   if(name==='identity')result.UserId='drift';
  }return result;};await assert.rejects(run(f));
 }
});
test('artifact writes are exclusive, idempotent and refuse corrupt or extra files',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-catalog-runtime-artifact-'));
 try{const f=fixture(),directory=writeCatalogRuntimeCandidate(root,f.candidate);
  assert.equal(writeCatalogRuntimeCandidate(root,f.candidate),directory);
  verifyCatalogRuntimeCandidate(readCareRegisteredCandidate(directory),f.current);
  writeFileSync(resolve(directory,'index.js'),'corrupt');assert.throws(()=>writeCatalogRuntimeCandidate(root,f.candidate),/artifact_collision/);
  assert.equal(readFileSync(resolve(directory,'index.js'),'utf8'),'corrupt');
  writeFileSync(resolve(directory,'index.js'),f.candidate.bundle);writeFileSync(resolve(directory,'approval.json'),'{}');
  assert.throws(()=>readCareRegisteredCandidate(directory),/artifact_layout/);
 }finally{dispose(root);}
});
test('artifact parent junction is refused without modifying its destination',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-catalog-runtime-link-')),other=mkdtempSync(resolve(tmpdir(),'alp-catalog-runtime-destination-'));
 try{writeFileSync(resolve(other,'marker'),'unchanged');symlinkSync(other,resolve(root,'dist'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>writeCatalogRuntimeCandidate(root,fixture().candidate),/artifact_directory/);
  assert.equal(readFileSync(resolve(other,'marker'),'utf8'),'unchanged');
 }finally{dispose(root);dispose(other);}
});
test('public parser admits source paths only; no target, saved report, profile, publish, approval or execution switches',()=>{
 const good=['--v2-root','v2','--artifact','artifact','--custody-root','custody','--deployed-desktop-root','old-desktop',
  '--deployed-v2-root','old-v2','--inspect-fictional-catalog-runtime-only'];
 assert.equal(Object.keys(catalogRuntimeInspectArguments(good)).length,5);
 for(const flag of ['--profile','--account','--report','--phi','--deploy','--publish','--approved']){
  assert.throws(()=>catalogRuntimeInspectArguments([...good,flag,'true']));
  const bad=[...good];bad[0]=flag;assert.throws(()=>catalogRuntimeInspectArguments(bad));
 }
 for(const key of ['AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_S3','AWS_ENDPOINT_URL_RDS_DATA']){
  assert.throws(()=>catalogRuntimeObservationEnvironment({[key]:'https://unreviewed.example'}));
 }
 catalogRuntimeObservationEnvironment({});assert.equal(canonical(catalogRuntimePredecessor()),canonical(catalogRuntimePredecessor()));
});
