import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync,mkdtempSync,existsSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {createCareRegisteredCandidate} from './synthetic-care-registered-release.mjs';
import {canonicalCareRegistrationDescriptor} from './care-canonical-migrations.mjs';
import {careRegisteredUploadArguments,verifyRegisteredUploadPreflight,runRegisteredUpload,registeredOperationDirectory} from './upload-synthetic-care-registered-release.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
function fixture(){
 const current={desktop:{commit:'a'.repeat(40),clean:true,files:20,sha256:'b'.repeat(64)},
  mobile:{source:{commit:'c'.repeat(40),clean:true,files:21,sha256:'d'.repeat(64)},built:false,deviceVerified:false,
   ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'e'.repeat(64)]))},
  migrations:canonicalCareRegistrationDescriptor(),templateSha256:'f'.repeat(64)};
 const candidate=createCareRegisteredCandidate(current,Buffer.from('fictional registered code'));
 let clock=Date.parse('2026-10-08T06:00:00Z');
 const preparation={contract:'synthetic-care-registered-preflight/1',observedAt:new Date(clock).toISOString(),current:structuredClone(current),
  execution:'synthetic-staging',account:P.account,candidateZipSha256:candidate.manifest.zipSha256,control:{revision:'fictional'},
  liveTargetObserved:true,independentSourceRebuildVerified:true,predecessorBytesVerified:true,repeatedReadbackVerified:true,reportIsNotAuthority:true,
  ...Object.fromEntries(['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
   'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].map(k=>[k,false]))};
 const caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 const commands=[],events=[];
 const response=()=>({VersionId:'fictional-version',ContentLength:candidate.zip.length,ContentType:'application/zip',
  ServerSideEncryption:'aws:kms',SSEKMSKeyId:P.keyArn,BucketKeyEnabled:true,ChecksumType:'FULL_OBJECT',
  ChecksumSHA256:Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64'),Metadata:{
   'source-desktop':current.desktop.commit,'source-mobile':current.mobile.source.commit,sha256:candidate.manifest.zipSha256,
   execution:'synthetic-staging','phi-allowed':'false'}});
 const port={now:()=>clock,current:async()=>structuredClone(current),identity:async()=>structuredClone(caller),
  preflight:async()=>{events.push({stage:'preflight'});return structuredClone(preparation);},
  control:async()=>structuredClone(preparation.control),record:e=>events.push(e),admit:e=>events.push(e),
  send:async(command)=>{
   commands.push(command);
   switch(command.constructor.name){
    case 'GetBucketLocationCommand':return {LocationConstraint:P.region};
    case 'GetBucketVersioningCommand':return {Status:'Enabled'};
    case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{BucketKeyEnabled:true,
     ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:P.keyArn}}]}};
    case 'PutObjectCommand':events.push({stage:'actual_put'});return response();
    case 'HeadObjectCommand':return response();
    case 'GetObjectCommand':return {...response(),Body:Readable.from([candidate.zip])};
    default:throw Error('unexpected command');
   }
  }};
 return {current,candidate,preparation,caller,commands,events,port,advance:ms=>clock+=ms};
}
const run=f=>runRegisteredUpload(f.candidate,f.current,f.port);
test('registered upload binds fresh current pair, exact encrypted bytes/version and admits before write; no deployment',async()=>{
 const f=fixture(),result=await run(f);
 assert.equal(result.candidateUploaded,true);assert.equal(result.artifact.exactVersionReadbackVerified,true);
 for(const k of ['changeSetCreated','deployed','schemaChanged','recoveryRehearsed','hostedAcceptance','erasureAccepted',
  'releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(result[k],false);
 const put=f.commands.find(c=>c.constructor.name==='PutObjectCommand');
 assert.equal(put.input.IfNoneMatch,'*');assert.equal(put.input.Key,f.candidate.manifest.key);
 assert(f.events.findIndex(e=>e.stage==='registered_artifact_put_admitted')<f.events.findIndex(e=>e.stage==='actual_put'));
 assert.equal(f.commands.filter(c=>c.constructor.name==='PutObjectCommand').length,1);
 assert.equal(f.events[0].stage,'preflight');
});
test('wrong or stale preflight, modified source, root identity and control drift refuse before admission',async()=>{
 for(const mutate of [f=>f.preparation.observedAt='invalid',f=>f.advance(120001),f=>f.preparation.account='173535830222',
  f=>f.preparation.candidateZipSha256='0'.repeat(64),f=>f.preparation.current.mobile.source.commit='0'.repeat(40),
  f=>f.preparation.independentSourceRebuildVerified=false,f=>f.preparation.reportIsNotAuthority=false,
  ...['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','releaseAccepted','phiAllowed','paidMobileBuildStarted'].map(k=>f=>f.preparation[k]=true),
  f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,f=>{f.port.current=async()=>({...f.current,desktop:{...f.current.desktop,clean:false}});},
  f=>{f.port.control=async()=>({revision:'changed'});},f=>{f.port.preflight=async()=>{throw Error('failed');};}]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
  assert.equal(f.events.some(e=>e.stage==='registered_artifact_put_admitted'),false);assert.equal(f.commands.length,0);
 }
});
test('freshness and source are rechecked after potentially slow control observation',async()=>{
 for(const kind of ['expiry','source']){
  const f=fixture();f.port.control=async()=>{
   if(kind==='expiry')f.advance(120001);else f.current.desktop.sha256='0'.repeat(64);
   return structuredClone(f.preparation.control);
  };
  await assert.rejects(run(f));assert.equal(f.commands.length,0);
 }
});
test('drift or expiry during bucket observations refuses at the actual put boundary',async()=>{
 for(const kind of ['expiry','source','principal','control']){
  const f=fixture(),send=f.port.send;
  f.port.send=async(c)=>{const r=await send(c);if(c.constructor.name==='GetBucketEncryptionCommand'){
   if(kind==='expiry')f.advance(120001);
   if(kind==='source')f.current.desktop.sha256='0'.repeat(64);
   if(kind==='principal')f.caller.Arn+='changed';
   if(kind==='control')f.port.control=async()=>({revision:'changed'});
  }return r;};
  await assert.rejects(run(f));assert.equal(f.commands.some(c=>c.constructor.name==='PutObjectCommand'),false);
 }
});
test('unknown writes are never repeated; postwrite drift cannot certify successful completion',async()=>{
 for(const afterWrite of [false,true]){
  const f=fixture(),send=f.port.send;
  f.port.send=async(c)=>{if(c.constructor.name==='PutObjectCommand'){
   if(!afterWrite){f.commands.push(c);throw Error('lost put response');}
   f.port.control=async()=>({revision:'changed'});
  }return send(c);};
  await assert.rejects(run(f));assert.equal(f.commands.filter(c=>c.constructor.name==='PutObjectCommand').length,1);
  assert.equal(f.events.some(e=>e.stage==='registered_artifact_exact_version_verified'),false);
 }
});
test('registered purpose shares exclusive custody, retains unknown write and settles only its own lock',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-custody-'));
 try{const f=fixture(),out=resolve(root,'operations'),custody=createIntentUploadCustody(root,out,f.current,'registered-artifact-upload');
  assert.equal(JSON.parse(readFileSync(custody.lock,'utf8')).purpose,'registered-artifact-upload');
  assert.throws(()=>createIntentUploadCustody(root,out,f.current),/operator_lock/);
  custody.admit({stage:'registered_artifact_put_admitted'});custody.close();assert.equal(existsSync(custody.lock),true);
  assert.match(readFileSync(custody.journal,'utf8'),/registered_artifact_put_admitted/);
  custody.settle();custody.close();assert.equal(existsSync(custody.lock),false);
  assert.throws(()=>createIntentUploadCustody(root,out,f.current,'production'),/custody_purpose/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('fixed CLI has no saved report, environment, target, execute or paid-build authority',()=>{
 careRegisteredUploadArguments(['--v2-root','.','--artifact','.','--upload-fictional-registered-code-only']);
 for(const args of [[],['--v2-root','.','--artifact','.','--deploy'],
  ['--v2-root','.','--report','pass.json','--upload-fictional-registered-code-only'],
  ['--v2-root','.','--artifact','.','--upload-fictional-registered-code-only','--profile','prod']])assert.throws(()=>careRegisteredUploadArguments(args));
 const source=readFileSync(new URL('./upload-synthetic-care-registered-release.mjs',import.meta.url),'utf8');
 assert.match(source,/preflight:\(\)=>observeCareRegisteredPreflight\(root,mobileRoot,directory\)/);
 assert.match(source,/maxAttempts:1/);assert.match(source,/custody\.admit/);
 assert.doesNotMatch(source,/'execute-change-set'|'update-stack'|'update-function-code'|process\.env|--report|--target/);
 const f=fixture();assert.throws(()=>verifyRegisteredUploadPreflight(f.preparation,f.candidate,{...f.current,templateSha256:'0'.repeat(64)},f.port.now()));
});
test('operation directory is separate from immutable artifacts and refuses a shared-lock junction',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'alp-registered-operation-root-')),
  other=mkdtempSync(resolve(tmpdir(),'alp-registered-operation-other-'));
 try{const f=fixture(),dist=resolve(root,'dist');mkdirSync(dist);
  symlinkSync(other,resolve(dist,'synthetic-care-routing'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>registeredOperationDirectory(root,f.current,f.candidate),/operations_directory/);
  assert.equal(existsSync(resolve(other,'operator.lock')),false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
