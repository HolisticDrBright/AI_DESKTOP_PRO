import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C} from './synthetic-care-registered-release.mjs';
import {CATALOG_RUNTIME as K,createCatalogRuntimeCandidate,verifyCatalogRuntimeCandidate,catalogRuntimePredecessor} from './synthetic-catalog-runtime-release.mjs';
import {catalogRuntimePredecessorTemplate,runCatalogRuntimePreflight} from './catalog-runtime-preflight.mjs';
import {careRegisteredControlFixture} from './test-fixtures/care-registered-control.mjs';
import {careRegisteredDatabaseFixture} from './test-fixtures/care-registered-database.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {runCatalogRuntimeUpload,verifyCatalogRuntimeUploadPreflight,catalogRuntimeUploadArguments,
 catalogRuntimeOperationDirectory,verifyCatalogRuntimeSharedLocks,saveCatalogRuntimeReceipt} from './catalog-runtime-upload.mjs';
import {verifyFailedCatalogRuntimeUploadCustody,runCatalogRuntimeUploadReconciliation,
 catalogRuntimeUploadReconciliationArguments} from './catalog-runtime-upload-reconciliation.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {inspectRegisteredUploadObject,archiveReconciledUploadLock,acquireRegisteredUploadReconciliationGuard} from './reconcile-synthetic-care-registered-upload.mjs';
async function fixture(){
 const f=careRegisteredControlFixture(),candidate=createCatalogRuntimeCandidate(f.current,f.candidate.bundle);
 f.raw.template=catalogRuntimePredecessorTemplate(f.source);
 f.raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=catalogRuntimePredecessor().key;
 f.raw.fn.CodeSha256=Buffer.from(K.predecessorZip,'hex').toString('base64');f.raw.fn.CodeSize=K.predecessorBytes;
 const recovery={configuration:{...structuredClone(f.raw.fn),FunctionArn:R.latestArn+':2',Version:'2',
  CodeSha256:Buffer.from(C.predecessorZip,'hex').toString('base64'),CodeSize:C.predecessorBytes},sha256:C.predecessorZip,bytes:C.predecessorBytes,policy:null};
 const caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 const db=careRegisteredDatabaseFixture(f.current,f.now);let clock=f.now;
 const preparation=await runCatalogRuntimePreflight(candidate,f.current,f.source,{
  sourceText:f.sourceText,now:()=>clock,current:async()=>structuredClone(f.current),identity:async()=>structuredClone(caller),
  database:async()=>structuredClone(db),control:async()=>structuredClone(f.raw),retained:async()=>structuredClone(recovery),
  rebuild:async()=>({...verifyCatalogRuntimeCandidate(candidate,f.current),sourceRebuilt:true,
   desktopCommit:f.current.desktop.commit,mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,
   erasureAccepted:false,physicalDeviceAcceptance:false,paidMobileBuildStarted:false}),
  downloads:async()=>({managedSha256:K.predecessorZip,managedBytes:K.predecessorBytes,storedSha256:K.predecessorZip,
   storedBytes:K.predecessorBytes,version:K.predecessorVersion,exactBytesVerified:true,frozenSourceRebuilt:true}),
 });
 const commands=[],events=[],response={VersionId:'fictional-version',ContentLength:candidate.zip.length,ContentType:'application/zip',
  ServerSideEncryption:'aws:kms',SSEKMSKeyId:P.keyArn,BucketKeyEnabled:true,ChecksumType:'FULL_OBJECT',
  ChecksumSHA256:Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64'),Metadata:{
   'source-desktop':f.current.desktop.commit,'source-mobile':f.current.mobile.source.commit,sha256:candidate.manifest.zipSha256,
   execution:'synthetic-staging','phi-allowed':'false'}};
 const port={now:()=>clock,current:async()=>structuredClone(f.current),identity:async()=>structuredClone(caller),custody:async()=>{},
  preflight:async()=>structuredClone(preparation),control:async()=>structuredClone(preparation.control),
  record:async e=>events.push(e),admit:async e=>events.push(e),send:async c=>{
   commands.push(c);switch(c.constructor.name){
    case 'GetBucketLocationCommand':return {LocationConstraint:P.region};
    case 'GetBucketVersioningCommand':return {Status:'Enabled'};
    case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{BucketKeyEnabled:true,
     ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:P.keyArn}}]}};
    case 'PutObjectCommand':events.push({stage:'actual_put'});return structuredClone(response);
    case 'HeadObjectCommand':return structuredClone(response);
    case 'GetObjectCommand':return {...structuredClone(response),Body:Readable.from([candidate.zip])};
    default:throw Error('unexpected command');
   }
  }};
 return {...f,candidate,caller,preparation,commands,events,response,port,advance:ms=>clock+=ms};
}
const run=f=>runCatalogRuntimeUpload(f.candidate,f.current,f.port);
function dispose(root){assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('alp-catalog-upload-'));rmSync(root,{recursive:true,force:true});}
test('artifact upload admits once before PUT and verifies exact encrypted version without deploying',async()=>{
 const f=await fixture(),r=await run(f);
 assert.equal(r.candidateUploaded,true);assert.equal(r.artifact.exactVersionReadbackVerified,true);
 assert.equal(r.preparation.retained.sameArtifactAsLatest,false);
 for(const k of ['changeSetCreated','deployed','schemaChanged','recoveryRehearsed','hostedAcceptance','erasureAccepted','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 const put=f.commands.find(c=>c.constructor.name==='PutObjectCommand');assert.equal(put.input.IfNoneMatch,'*');
 assert.equal(put.input.ExpectedBucketOwner,P.account);assert.equal(put.input.Key,f.candidate.manifest.key);
 assert.equal(f.commands.filter(c=>c.constructor.name==='PutObjectCommand').length,1);
 assert(f.events.findIndex(e=>e.stage==='catalog_runtime_artifact_put_admitted')<f.events.findIndex(e=>e.stage==='actual_put'));
});
test('preflight needs exact current source, canonical database history, local rebuild, predecessor and no approval flags',async()=>{
 const changes=[f=>f.preparation.approved=false,f=>f.preparation.deployAuthorized=true,f=>f.preparation.phiAllowed=true,
  f=>f.preparation.account='173535830222',f=>f.preparation.contract='synthetic-care-registered-preflight/1',
  f=>f.preparation.current.desktop.sha256='0'.repeat(64),f=>f.preparation.candidateZipSha256='0'.repeat(64),
  f=>f.preparation.databaseAfter.referenceMigrationCount=2,f=>f.preparation.databaseAfter.catalogInspection.rowCount++,
  f=>delete f.preparation.databaseBefore,f=>f.preparation.localArtifact.sourceRebuilt=false,
  f=>f.preparation.localArtifact.hostedAcceptance=true,f=>f.preparation.predecessorDownload.managedSha256=C.predecessorZip,
  f=>f.preparation.retained.sameArtifactAsLatest=true,f=>f.preparation.retained.invokePermissionAbsent=false,
  f=>f.preparation.control.apiRouteCount=111,f=>f.preparation.control.iamVerified=false,
  f=>f.preparation.observedAt=new Date(f.now+1).toISOString(),f=>f.advance(120001)];
 for(const change of changes){const f=await fixture();change(f);await assert.rejects(run(f),undefined,change.toString());
  assert.equal(f.commands.length,0);}
});
test('bucket observations cannot admit expired, changed source, principal, custody or control',async()=>{
 for(const kind of ['expiry','source','principal','custody','control']){
  const f=await fixture(),send=f.port.send;f.port.send=async c=>{const r=await send(c);
   if(c.constructor.name==='GetBucketEncryptionCommand'){
    if(kind==='expiry')f.advance(120001);if(kind==='source')f.current.desktop.sha256='0'.repeat(64);
    if(kind==='principal')f.caller.UserId='changed';if(kind==='custody')f.port.custody=async()=>{throw Error('custody changed');};
    if(kind==='control')f.port.control=async()=>({...f.preparation.control,revision:'changed'});
   }return r;};await assert.rejects(run(f));assert(!f.commands.some(c=>c.constructor.name==='PutObjectCommand'));
 }
});
test('admission must be durably awaited; rejected journal never reaches PUT',async()=>{
 const f=await fixture();f.port.admit=async()=>{await Promise.resolve();throw Error('journal failed');};
 await assert.rejects(run(f),/journal failed/);assert(!f.commands.some(c=>c.constructor.name==='PutObjectCommand'));
 const x=await fixture();x.port.record=async()=>{throw Error('preflight journal failed');};
 await assert.rejects(run(x));assert.equal(x.commands.length,0);
});
test('journal admission cannot extend freshness or hide source/control/custody drift before PUT',async()=>{
 for(const kind of ['expiry','source','control','custody']){
  const f=await fixture();f.port.admit=async()=>{
   if(kind==='expiry')f.advance(120001);if(kind==='source')f.current.desktop.sha256='0'.repeat(64);
   if(kind==='control')f.port.control=async()=>({changed:true});
   if(kind==='custody')f.port.custody=async()=>{throw Error('changed lock');};
  };await assert.rejects(run(f));assert(!f.commands.some(c=>c.constructor.name==='PutObjectCommand'));
 }
});
test('unknown PUT outcomes are never retried and post-write drift never certifies completion',async()=>{
 for(const kind of ['lost','control','source','custody','principal']){
  const f=await fixture(),send=f.port.send;f.port.send=async c=>{
   if(c.constructor.name==='PutObjectCommand'){
    if(kind==='lost'){f.commands.push(c);throw Error('lost response');}
    if(kind==='control')f.port.control=async()=>({changed:true});if(kind==='source')f.current.desktop.sha256='0'.repeat(64);
    if(kind==='custody')f.port.custody=async()=>{throw Error('lost lock');};if(kind==='principal')f.caller.UserId='changed';
   }return send(c);};await assert.rejects(run(f));assert.equal(f.commands.filter(c=>c.constructor.name==='PutObjectCommand').length,1);
  assert(!f.events.some(e=>e.stage==='catalog_runtime_artifact_exact_version_verified'));
 }
});
test('only exact 412 reuses matching version; wrong bytes, metadata or version refuse',async()=>{
 const f=await fixture(),send=f.port.send;f.port.send=async c=>{
  if(c.constructor.name==='PutObjectCommand'){f.commands.push(c);throw Object.assign(Error('exists'),{name:'PreconditionFailed',$metadata:{httpStatusCode:412}});}return send(c);};
 const r=await run(f);assert.equal(r.artifact.reused,true);assert.equal(r.awsMutationPerformed,false);
 for(const change of [x=>x.response.Metadata['phi-allowed']='true',x=>x.response.VersionId='null',x=>x.response.ChecksumSHA256='wrong',
  x=>{const send=x.port.send;x.port.send=async c=>c.constructor.name==='GetObjectCommand'?{...x.response,Body:Readable.from([Buffer.from('wrong')])}:send(c);}]){
  const x=await fixture();change(x);await assert.rejects(run(x));assert.equal(x.commands.filter(c=>c.constructor.name==='PutObjectCommand').length,1);
 }
});
test('candidate bytes are captured before asynchronous observers and cannot be swapped during preflight',async()=>{
 const f=await fixture(),savedZip=Buffer.from(f.candidate.zip),send=f.port.send;
 f.port.preflight=async()=>{f.candidate.zip.fill(0);return structuredClone(f.preparation);};
 f.port.send=async c=>c.constructor.name==='GetObjectCommand'?{...f.response,Body:Readable.from([savedZip])}:send(c);
 await run(f);assert(f.commands.find(c=>c.constructor.name==='PutObjectCommand').input.Body.equals(savedZip));
});
async function failedFixture(){
 const f=await fixture(),operator={...structuredClone(f.current),desktop:{...f.current.desktop,commit:'1'.repeat(40),sha256:'2'.repeat(64)}},
  lock={runId:'3'.repeat(32),pid:1234567,purpose:'catalog-runtime-artifact-upload',desktop:f.current.desktop,mobile:f.current.mobile};
 const events=[{at:new Date(f.now).toISOString(),stage:'catalog_runtime_upload_started',runId:lock.runId},
  {at:new Date(f.now+1000).toISOString(),stage:'catalog_runtime_live_preflight_verified'},
  {at:new Date(f.now+2000).toISOString(),stage:'catalog_runtime_artifact_put_admitted',key:f.candidate.manifest.key,sha256:f.candidate.manifest.zipSha256},
  {at:new Date(f.now+3000).toISOString(),stage:'catalog_runtime_upload_finding',writeAdmitted:true}];
 const encode=()=>({lockBytes:Buffer.from(JSON.stringify(lock)+'\n'),journalBytes:Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});
 const custody=encode(),storage={state:'absent_at_observation',versionId:null,bytesVerified:false,originalPutOutcome:'unknown',deletionCertified:false};
 f.advance(120000);const port={now:f.port.now,current:async()=>structuredClone(operator),identity:f.port.identity,writerStopped:async()=>true,
  custody:async()=>encode(),control:async()=>structuredClone(f.preparation.control),storage:async()=>structuredClone(storage)};
 return {...f,operator,lock,events,encode,custody,storage,reconcilePort:port};
}
const reconcile=f=>runCatalogRuntimeUploadReconciliation(f.candidate,f.operator,f.custody,f.reconcilePort);
test('stopped upload with missing terminal entry is inspectable, not a claim PUT failed or data was deleted',async()=>{
 for(const terminal of ['finding','crash','verified','completed','completed-finding']){
  const f=await failedFixture();f.events.pop();
  if(['verified','completed','completed-finding'].includes(terminal))f.events.push({at:new Date(f.now+3000).toISOString(),stage:'catalog_runtime_artifact_exact_version_verified'});
  if(['completed','completed-finding'].includes(terminal))f.events.push({at:new Date(f.now+4000).toISOString(),stage:'catalog_runtime_upload_completed'});
  if(['finding','completed-finding'].includes(terminal))f.events.push({at:new Date(f.now+5000).toISOString(),stage:'catalog_runtime_upload_finding',writeAdmitted:true});
  f.custody=f.encode();const r=await reconcile(f);assert.equal(r.originalPutOutcome,'unknown');assert.equal(r.storage.deletionCertified,false);
  for(const k of ['retryPerformed','awsMutationPerformed','deployed','schemaChanged','hostedAcceptance','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 }
});
test('custody refuses wrong source, key, malformed encoding, non-prefix stages, duplication and unsettled writer',async()=>{
 const changes=[f=>f.lock.purpose='registered-artifact-upload',f=>f.lock.pid=0,f=>f.lock.runId='bad',f=>f.lock.extra=true,
  f=>f.lock.desktop.commit='0'.repeat(40),f=>f.events[2].key='other',f=>f.events[2].sha256='0'.repeat(64),
  f=>f.events[0].runId='other',f=>f.events[1].stage='catalog_runtime_artifact_exact_version_verified',
  f=>f.events.push({...f.events[2]}),f=>f.events.reverse(),f=>f.events.at(-1).writeAdmitted=false,
  f=>f.events.at(-1).at=new Date(f.port.now()+1).toISOString(),f=>f.events.pop()&&f.events.pop(),
  f=>f.events.at(-1).at=new Date(f.port.now()-1000).toISOString()];
 for(const change of changes){const f=await failedFixture();change(f);assert.throws(()=>verifyFailedCatalogRuntimeUploadCustody(f.encode(),f.candidate,f.port.now()));}
 const f=await failedFixture(),bad={...f.custody,lockBytes:Buffer.from(f.custody.lockBytes.toString().replace('"pid":','"pid":1,"pid":'))};
 assert.throws(()=>verifyFailedCatalogRuntimeUploadCustody(bad,f.candidate,f.port.now()));
});
test('live writer, drift, permission denial or unstable repeated storage blocks reconciliation',async()=>{
 for(const change of [f=>f.reconcilePort.writerStopped=async()=>false,f=>f.caller.Account='173535830222',
  f=>f.operator.desktop.clean=false,f=>f.operator.mobile.source.commit='0'.repeat(40),
  f=>f.reconcilePort.current=async()=>({...f.operator,templateSha256:'0'.repeat(64)}),
  f=>f.events[2].key='changed',f=>{let n=0;f.reconcilePort.control=async()=>({revision:++n});},
  f=>{let n=0;f.reconcilePort.storage=async()=>({...f.storage,versionId:String(++n)});},
  f=>f.storage.deletionCertified=true,f=>f.storage.originalPutOutcome='failed',
  f=>f.reconcilePort.storage=async()=>{throw Object.assign(Error('denied'),{name:'AccessDenied'});},
  f=>{let n=0;f.reconcilePort.identity=async()=>({...f.caller,UserId:String(++n)});}]){
  const f=await failedFixture();change(f);await assert.rejects(reconcile(f));
 }
});
test('reconciliation captures immutable application and custody before first asynchronous observation',async()=>{
 const f=await failedFixture(),original=f.reconcilePort.identity;
 f.reconcilePort.identity=async()=>{f.candidate.zip.fill(0);return original();};
 assert.equal((await reconcile(f)).applicationSource.desktop.commit,f.current.desktop.commit);
});
test('matching storage is physically read with exact version and bounded bytes; writes have no reconciliation port',async()=>{
 const f=await fixture(),commands=[];
 const send=async c=>{commands.push(c);if(c.constructor.name==='ListObjectVersionsCommand')return {IsTruncated:false,Versions:[{
  Key:f.candidate.manifest.key,Size:f.candidate.zip.length,VersionId:'fictional-version',IsLatest:true}]};
  assert.notEqual(c.constructor.name,'PutObjectCommand');return f.port.send(c);};
 const observed=await inspectRegisteredUploadObject(f.candidate,send);assert.equal(observed.bytesVerified,true);
 assert(commands.filter(c=>['HeadObjectCommand','GetObjectCommand'].includes(c.constructor.name)).every(c=>c.input.VersionId==='fictional-version'));
 const x=await failedFixture();Object.assign(x.storage,observed);assert.equal((await reconcile(x)).storage.bytesVerified,true);
});
test('shared custody is exclusive, retains admitted uncertain writes, and archives only exact local stopped-writer evidence',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-catalog-upload-custody-'));
 try{const f=await fixture(),out=catalogRuntimeOperationDirectory(root,f.current,f.candidate);
  verifyCatalogRuntimeSharedLocks(root);const custody=createIntentUploadCustody(root,out,f.current,'catalog-runtime-artifact-upload');
  verifyCatalogRuntimeSharedLocks(root,true);assert.throws(()=>verifyCatalogRuntimeSharedLocks(root),/shared_lock_active/);
  assert.throws(()=>createIntentUploadCustody(root,out,f.current,'catalog-runtime-artifact-upload'),/operator_lock/);
  custody.admit({stage:'catalog_runtime_artifact_put_admitted'});custody.close();assert(existsSync(custody.lock));
  const guard=acquireRegisteredUploadReconciliationGuard(resolve(root,'dist/synthetic-care-routing'),f.current);
  verifyCatalogRuntimeSharedLocks(root,true,true);const lockBytes=readFileSync(custody.lock),journalBytes=readFileSync(custody.journal);
  const result=archiveReconciledUploadLock({...custody,lockBytes,journalBytes,out,guard},{runId:custody.runId,
   writerStopped:true,repeatedStorageReadback:true,originalPutOutcome:'unknown',reportIsNotAuthority:true,awsMutationPerformed:false,deployed:false});
  assert.equal(result.operatorCustodySettled,true);assert(!existsSync(custody.lock));assert(readFileSync(result.archive).equals(lockBytes));
  assert(readFileSync(custody.journal).equals(journalBytes));guard.close();
  saveCatalogRuntimeReceipt(resolve(out,'receipt.json'),{verified:false});assert.throws(()=>saveCatalogRuntimeReceipt(resolve(out,'receipt.json'),{verified:true}));
  assert.equal(JSON.parse(readFileSync(resolve(out,'receipt.json'))).verified,false);
 }finally{dispose(root);}
});
test('operations refuse shared-directory junctions and foreign locks without touching destination',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-catalog-upload-root-')),other=mkdtempSync(resolve(tmpdir(),'alp-catalog-upload-destination-'));
 try{const f=await fixture();mkdirSync(resolve(root,'dist'));symlinkSync(other,resolve(root,'dist/synthetic-care-routing'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>catalogRuntimeOperationDirectory(root,f.current,f.candidate),/operations_directory/);assert(!existsSync(resolve(other,'operator.lock')));
 }finally{dispose(root);dispose(other);}
});
test('public commands expose fixed source paths only, with no report, target, publish, approve or deploy override',async()=>{
 const args=['--v2-root','v2','--artifact','artifact','--custody-root','custody','--deployed-desktop-root','old-desktop','--deployed-v2-root','old-v2'];
 for(const [parse,flag] of [[catalogRuntimeUploadArguments,'--upload-fictional-catalog-runtime-code-only'],
  [catalogRuntimeUploadReconciliationArguments,'--reconcile-fictional-catalog-runtime-upload-only']]){
  assert.equal(Object.keys(parse([...args,flag])).length,5);
  for(const extra of ['--report','--profile','--account','--phi','--deploy','--approved'])assert.throws(()=>parse([...args,flag,extra,'true']));
 }
 const f=await fixture();verifyCatalogRuntimeUploadPreflight(f.preparation,f.candidate,f.current,f.port.now());
 for(const file of ['catalog-runtime-upload.mjs','catalog-runtime-upload-reconciliation.mjs']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');assert.match(source,/AWS_MAX_ATTEMPTS='1'/);
  assert.match(source,/maxAttempts:1/);assert.doesNotMatch(source,/'update-stack'|'execute-change-set'|'update-function-code'/);
 }
});
