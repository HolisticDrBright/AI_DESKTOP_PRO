import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync,writeFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PutObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {createCareRegisteredCandidate} from './synthetic-care-registered-release.mjs';
import {canonicalCareRegistrationDescriptor} from './care-canonical-migrations.mjs';
import {REGISTERED_UPLOAD_TRANSPORT,registeredUploadTransportFailure} from './upload-synthetic-care-registered-release.mjs';
import {registeredUploadReconciliationArguments,verifyFailedRegisteredUploadCustody,inspectRegisteredUploadObject,
 runRegisteredUploadReconciliation,archiveReconciledUploadLock,stoppedUploadWriter,acquireRegisteredUploadReconciliationGuard} from './reconcile-synthetic-care-registered-upload.mjs';
function fixture(){
 const current={desktop:{commit:'a'.repeat(40),clean:true,files:20,sha256:'b'.repeat(64)},
  mobile:{source:{commit:'c'.repeat(40),clean:true,files:21,sha256:'d'.repeat(64)},built:false,deviceVerified:false,
   ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'e'.repeat(64)]))},
  migrations:canonicalCareRegistrationDescriptor(),templateSha256:'f'.repeat(64)};
 const candidate=createCareRegisteredCandidate(current,Buffer.from('fictional immutable code')),
  operator={...structuredClone(current),desktop:{...current.desktop,commit:'1'.repeat(40),sha256:'2'.repeat(64)}},
  lock={runId:'3'.repeat(32),pid:1234567,purpose:'registered-artifact-upload',desktop:current.desktop,mobile:current.mobile};
 let now=Date.parse('2026-10-08T06:02:00Z');
 const events=[{at:'2026-10-08T06:00:00Z',stage:'registered_upload_started',runId:lock.runId},
  {at:'2026-10-08T06:00:01Z',stage:'registered_live_preflight_verified'},
  {at:'2026-10-08T06:00:02Z',stage:'registered_artifact_put_admitted',key:candidate.manifest.key,sha256:candidate.manifest.zipSha256},
  {at:'2026-10-08T06:00:03Z',stage:'registered_upload_finding',writeAdmitted:true}];
 const encode=()=>({lockBytes:Buffer.from(JSON.stringify(lock)+'\n'),journalBytes:Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 const custody=encode(),caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 const storage={state:'absent_at_observation',versionId:null,bytesVerified:false,originalPutOutcome:'unknown',deletionCertified:false};
 const port={now:()=>now,current:async()=>structuredClone(operator),identity:async()=>structuredClone(caller),
  writerStopped:async()=>true,custody:async()=>encode(),control:async()=>({revision:'fictional',phiAllowed:false}),
  storage:async()=>structuredClone(storage)};
 return {current,candidate,operator,lock,events,custody,caller,storage,port,encode,setNow:v=>now=v};
}
test('transport diagnostics are finite, command-bound and do not replay or expose error text',()=>{
 const put=new PutObjectCommand({}),head=new HeadObjectCommand({});
 for(const [error,reason] of [[{code:'ECONNRESET'},'connection_reset'],[{code:'ETIMEDOUT'},'timeout'],
  [{name:'AccessDenied'},'access_denied'],[{name:'PreconditionFailed'},'precondition_failed'],
  [{name:'__proto__'},'unknown'],[{name:'patient-private-token'},'unknown']]){
  error.message='Bearer secret health payload https://private?token=private';
  assert.equal(registeredUploadTransportFailure(put,error),'synthetic_care_registered_release_refused:upload_transport_put_'+reason);
  assert(!registeredUploadTransportFailure(head,error).includes('private'));
 }
 Object.defineProperty(put,'constructor',{value:{name:'BundledPutObjectCommand2'}});
 assert.match(registeredUploadTransportFailure(put,{code:'ECONNRESET'}),/put_connection_reset$/);
 assert.match(registeredUploadTransportFailure({constructor:{name:'PutObjectCommand'}},{}),/unknown_unknown$/);
 assert.equal(REGISTERED_UPLOAD_TRANSPORT.httpsAgent.keepAlive,false);assert.equal(REGISTERED_UPLOAD_TRANSPORT.requestTimeout,30000);
});
test('failed writer custody must be exact, bounded, admitted once and settled for at least 60 seconds',()=>{
 const f=fixture();assert.equal(verifyFailedRegisteredUploadCustody(f.custody,f.candidate,f.port.now()).lock.runId,f.lock.runId);
 for(const mutate of [x=>x.lock.purpose='intent-artifact-upload-proposal',x=>x.lock.desktop.commit='0'.repeat(40),
  x=>x.lock.mobile.source.commit='0'.repeat(40),x=>x.lock.pid=0,x=>x.lock.runId='bad',x=>x.lock.extra=true,
  x=>x.events[2].key='other',x=>x.events[2].sha256='0'.repeat(64),x=>x.events.push({...x.events[2]}),
  x=>x.events.at(-1).writeAdmitted=false,x=>x.events.at(-1).stage='registered_upload_completed',
  x=>x.events[0].runId='other',x=>x.events[1].stage='change_set_create_admitted',
  x=>x.events.at(-1).at='2026-10-08T06:03:00Z']){
  const x=fixture();mutate(x);assert.throws(()=>verifyFailedRegisteredUploadCustody(x.encode(),x.candidate,x.port.now()));
 }
 assert.throws(()=>verifyFailedRegisteredUploadCustody(f.custody,f.candidate,Date.parse('2026-10-08T06:00:40Z')));
 const duplicate={...f.custody,lockBytes:Buffer.from(f.custody.lockBytes.toString().replace('"pid":','"pid":1,"pid":'))};
 assert.throws(()=>verifyFailedRegisteredUploadCustody(duplicate,f.candidate,f.port.now()));
});
test('new clean operator may inspect old immutable application; no source, approval or deletion is promoted',async()=>{
 const f=fixture(),r=await runRegisteredUploadReconciliation(f.candidate,f.operator,f.custody,f.port);
 assert.equal(r.applicationSource.desktop.commit,f.current.desktop.commit);assert.equal(r.operatorSource.desktop.commit,f.operator.desktop.commit);
 assert.equal(r.storage.state,'absent_at_observation');assert.equal(r.originalPutOutcome,'unknown');
 for(const k of ['retryPerformed','awsMutationPerformed','deployed','schemaChanged','hostedAcceptance','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.equal(r.reportIsNotAuthority,true);
});
test('live writer, root, drift, unrelated source, changed custody or unstable AWS readback prevent settlement',async()=>{
 for(const mutate of [f=>f.port.writerStopped=async()=>false,f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,
  f=>f.operator.desktop.clean=false,f=>f.operator.mobile.source.commit='0'.repeat(40),f=>f.operator.templateSha256='0'.repeat(64),
  f=>f.events[2].key='changed',f=>f.port.current=async()=>({...f.operator,desktop:{...f.operator.desktop,sha256:'0'.repeat(64)}}),
  f=>{let n=0;f.port.control=async()=>({revision:++n});},
  f=>{let n=0;f.port.storage=async()=>({...f.storage,versionId:++n});},
  f=>f.storage.deletionCertified=true,f=>f.storage.originalPutOutcome='failed',f=>f.storage.state='deleted',
  f=>{let n=0;f.port.identity=async()=>({...f.caller,UserId:String(++n)});},
  f=>f.port.storage=async()=>{throw Object.assign(Error('private'),{name:'AccessDenied'});}]){
  const f=fixture();mutate(f);await assert.rejects(runRegisteredUploadReconciliation(f.candidate,f.operator,f.custody,f.port));
 }
 assert.throws(()=>stoppedUploadWriter(process.pid));
});
function storageFixture(stored=false){
 const f=fixture(),commands=[],response={VersionId:'fictional-version',ContentLength:f.candidate.zip.length,ContentType:'application/zip',
  ServerSideEncryption:'aws:kms',SSEKMSKeyId:P.keyArn,BucketKeyEnabled:true,ChecksumType:'FULL_OBJECT',
  ChecksumSHA256:Buffer.from(f.candidate.manifest.zipSha256,'hex').toString('base64'),Metadata:{
   'source-desktop':f.current.desktop.commit,'source-mobile':f.current.mobile.source.commit,sha256:f.candidate.manifest.zipSha256,
   execution:'synthetic-staging','phi-allowed':'false'}};
 const versions={IsTruncated:false,Versions:stored?[{Key:f.candidate.manifest.key,VersionId:'fictional-version',IsLatest:true,Size:f.candidate.zip.length}]:[]};
 const send=async c=>{commands.push(c);switch(c.constructor.name){
  case 'GetBucketLocationCommand':return {LocationConstraint:P.region};
  case 'GetBucketVersioningCommand':return {Status:'Enabled'};
  case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{BucketKeyEnabled:true,ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:P.keyArn}}]}};
  case 'ListObjectVersionsCommand':return versions;
  case 'HeadObjectCommand':if(stored)return response;throw Object.assign(Error('private'),{name:'NotFound',$metadata:{httpStatusCode:404}});
  case 'GetObjectCommand':return {...response,Body:Readable.from([f.candidate.zip])};
  default:throw Error('writes forbidden');
 }};return {...f,commands,response,versions,send};
}
test('storage absence needs complete exact-prefix listing and exact HEAD 404, never a denied lookup',async()=>{
 const f=storageFixture(),r=await inspectRegisteredUploadObject(f.candidate,f.send);
 assert.equal(r.state,'absent_at_observation');assert.equal(r.originalPutOutcome,'unknown');
 assert(f.commands.every(c=>!['PutObjectCommand','DeleteObjectCommand'].includes(c.constructor.name)));
 for(const mutate of [x=>x.versions.IsTruncated=true,x=>x.versions.NextKeyMarker='unread',x=>x.versions.NextVersionIdMarker='unread',
  x=>x.versions.Versions=[{Key:'other'}],x=>x.versions.DeleteMarkers=[{Key:x.candidate.manifest.key,VersionId:'deleted'}],
  x=>{const send=x.send;x.send=async c=>c instanceof HeadObjectCommand?Promise.reject(Object.assign(Error('private'),{name:'NotFound',$metadata:{httpStatusCode:403}})):send(c);},
  x=>{const send=x.send;x.send=async c=>c instanceof HeadObjectCommand?{}:send(c);}]){
  const x=storageFixture();mutate(x);await assert.rejects(inspectRegisteredUploadObject(x.candidate,x.send));
 }
});
test('stored outcome requires one exact encrypted version and actual bounded bytes; mismatch retains custody',async()=>{
 const f=storageFixture(true),r=await inspectRegisteredUploadObject(f.candidate,f.send);
 assert.equal(r.state,'stored_exact_version');assert.equal(r.bytesVerified,true);assert.equal(r.originalPutOutcome,'unknown');
 assert(f.commands.filter(c=>['HeadObjectCommand','GetObjectCommand'].includes(c.constructor.name)).every(c=>c.input.VersionId==='fictional-version'));
 for(const mutate of [x=>x.versions.Versions.push({...x.versions.Versions[0]}),x=>x.versions.Versions[0].IsLatest=false,
  x=>x.versions.Versions[0].Size++,x=>x.response.VersionId='other',x=>x.response.ChecksumSHA256='wrong',
  x=>x.response.Metadata['phi-allowed']='true',x=>{const send=x.send;x.send=async c=>c.constructor.name==='GetObjectCommand'
   ?{...x.response,Body:Readable.from([Buffer.from('wrong')])}:send(c);}]){
  const x=storageFixture(true);mutate(x);await assert.rejects(inspectRegisteredUploadObject(x.candidate,x.send));
 }
});
test('local lock is archived recoverably only after durable receipt; original journal/artifact are untouched',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-upload-reconciliation-'));
 try{const f=fixture(),report=await runRegisteredUploadReconciliation(f.candidate,f.operator,f.custody,f.port),
  guard=acquireRegisteredUploadReconciliationGuard(root,f.operator),
  custody={...f.custody,lock:resolve(root,'operator.lock'),journal:resolve(root,'original.events.jsonl'),out:root,guard};
  assert.throws(()=>acquireRegisteredUploadReconciliationGuard(root,f.operator),/guard_active/);
  writeFileSync(custody.lock,custody.lockBytes);writeFileSync(custody.journal,custody.journalBytes);
  const archived=archiveReconciledUploadLock(custody,report);
  assert.equal(existsSync(custody.lock),false);assert(readFileSync(archived.archive).equals(custody.lockBytes));
  assert(readFileSync(custody.journal).equals(custody.journalBytes));assert.equal(JSON.parse(readFileSync(archived.receipt)).originalPutOutcome,'unknown');
  writeFileSync(custody.lock,custody.lockBytes);writeFileSync(custody.journal,'changed');
  assert.throws(()=>archiveReconciledUploadLock(custody,report));assert.equal(existsSync(custody.lock),true);
  guard.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('reconciliation CLI has no write, execution, report or target override; self and invalid writers are refused',()=>{
 registeredUploadReconciliationArguments(['--v2-root','.','--artifact','.','--reconcile-fictional-registered-upload-only']);
 for(const a of [[],['--v2-root','.','--artifact','.','--deploy'],['--v2-root','.','--report','.','--reconcile-fictional-registered-upload-only']])assert.throws(()=>registeredUploadReconciliationArguments(a));
 for(const pid of [process.pid,0,-1,1.5])assert.throws(()=>stoppedUploadWriter(pid));
 const source=readFileSync(new URL('./reconcile-synthetic-care-registered-upload.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/new PutObjectCommand|new DeleteObjectCommand|'execute-change-set'|'update-stack'|'update-function-code'|--target|--report|process\.env/);
});
