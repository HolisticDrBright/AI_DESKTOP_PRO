/** Code-only unexecuted proposal and stopped-writer observation. Fixed synthetic
 * target only; neither command executes, deletes, activates or starts a build. */
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,lstatSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText,buildCareIdentityBundle} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,assertCareRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCatalogRuntimeCandidate,verifyCatalogRuntimeArtifactBinding} from './synthetic-catalog-runtime-release.mjs';
import {catalogRuntimeInspectArguments,catalogRuntimeObservationEnvironment,observeCatalogRuntimePreflight} from './inspect-synthetic-catalog-runtime-release.mjs';
import {verifyCatalogRuntimeUploadPreflight,catalogRuntimeOperationDirectory,verifyCatalogRuntimeCustodyRoot,
 verifyCatalogRuntimeCustodyLocation,verifyCatalogRuntimeSharedLocks,saveCatalogRuntimeReceipt} from './catalog-runtime-upload.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {inspectRegisteredUploadObject,acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter} from './reconcile-synthetic-care-registered-upload.mjs';
import {observeCatalogRuntimeControlRaw} from './catalog-runtime-control-observer.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {catalogRuntimeCodeTemplateInputs,catalogRuntimeChangeSetBinding,verifyCatalogRuntimeProposalViews} from './catalog-runtime-code-change.mjs';
import {runCatalogRuntimeProposal} from './catalog-runtime-proposal.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {assertSyntheticMemberIdentity,observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_proposal_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
export function catalogRuntimeProposalArguments(args,reconcile=false){
 check(args.length===13&&args[10]==='--application-root'&&typeof args[11]==='string'&&args[11].trim()&&!args[11].startsWith('--')
  &&args[12]===(reconcile?'--reconcile-fictional-catalog-runtime-proposal-only':'--prepare-fictional-catalog-runtime-code-change-only'),'arguments');
 return {...catalogRuntimeInspectArguments([...args.slice(0,10),'--inspect-fictional-catalog-runtime-only']),applicationRoot:resolve(args[11])};
}
function aws(args){
 catalogRuntimeObservationEnvironment(process.env);
 try{const value=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return value.trim()?JSON.parse(value):{};}
 catch{refuseRegistered('catalog_runtime_proposal_aws_unconfirmed');}
}
function bounded(file,max){
 const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');
 const bytes=readFileSync(file),b=lstatSync(file);check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;
}
function durable(file,value){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){if(e?.code!=='EEXIST')throw e;}
 finally{if(fd!==undefined)closeSync(fd);}check(bounded(file,4*1024*1024).equals(bytes),'file_collision');
}
export async function verifyCatalogRuntimeOperatorApplication(root,options){
 const operator=careRegisteredCurrent(root,options.mobileRoot),current=careRegisteredCurrent(options.applicationRoot,options.mobileRoot),
  candidate=readCareRegisteredCandidate(options.directory);
 verifyCatalogRuntimeCandidate(candidate,current);
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)&&operator.templateSha256===current.templateSha256,'operator_binding');
 const rebuilt=await buildCareIdentityBundle(root),application=await buildCareIdentityBundle(options.applicationRoot);
 check(rebuilt.equals(candidate.bundle)&&application.equals(candidate.bundle),'operator_runtime_changed');
 check(equal(careRegisteredCurrent(root,options.mobileRoot),operator)&&equal(careRegisteredCurrent(options.applicationRoot,options.mobileRoot),current),'source_changed');
 return {operator,current,candidate};
}
function context(root,options,witness){
 const {operator,current,candidate}=witness;verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);
 const sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json');
 const unchanged=()=>{
  catalogRuntimeObservationEnvironment(process.env);verifyCatalogRuntimeCustodyLocation(root,options.custodyRoot);
  check(equal(careRegisteredCurrent(root,options.mobileRoot),operator)&&equal(careRegisteredCurrent(options.applicationRoot,options.mobileRoot),current),'source_changed');
  const reread=readCareRegisteredCandidate(options.directory);
  check(['zip','bundle','releaseBytes','manifestBytes'].every(k=>reread[k].equals(candidate[k])),'artifact_changed');
 };
 const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
 const stored=async()=>{unchanged();const observed=await inspectRegisteredUploadObject(candidate,(command,opts={})=>client.send(command,
  {...opts,abortSignal:opts.abortSignal??AbortSignal.timeout(30000)}));unchanged();
  check(observed.state==='stored_exact_version'&&observed.bytesVerified===true,'artifact_not_stored');
  return verifyCatalogRuntimeArtifactBinding(candidate,current,{bucket:P.bucket,key:candidate.manifest.key,versionId:observed.versionId,
   sha256:observed.sha256,bytes:observed.bytes,reused:true,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true});};
 return {operator,current,candidate,sourceText,unchanged,stored,close:()=>client.destroy(),
  preflight:()=>observeCatalogRuntimePreflight(options.applicationRoot,options)};
}
function folder(out,fixed){const path=resolve(out,'proposal-'+fixed.digest);
 try{mkdirSync(path,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')throw e;}
 const s=lstatSync(path);check(s.isDirectory()&&!s.isSymbolicLink(),'directory');return path;}
function listing(fixed){return collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',fixed.stackId],'Summaries','NextToken');}
function views(binding){
 const raw=aws(['cloudformation','get-template','--stack-name',binding.stackId,'--change-set-name',binding.id,'--template-stage','Original']).TemplateBody;
 return {summary:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--no-include-property-values','--no-paginate']),
  detailed:aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,'--include-property-values','--no-paginate']),
  template:typeof raw==='string'?JSON.parse(raw):raw};
}
/** Final live reread after storage I/O. This is not a saved-report authority. */
export function verifyCatalogRuntimeProposalPublication(result,view,raw,sourceText,candidate,current,artifact,now){
 const input=catalogRuntimeCodeTemplateInputs(sourceText,candidate,current,artifact),fixed=catalogRuntimeChangeSetBinding(input,current,artifact);
 const time=Date.parse(result.preflightObservedAt);
 check(Number.isFinite(now)&&Number.isFinite(time)&&time<=now&&now-time<=120000,'publication_expired');
 check(result.stackId===fixed.stackId&&result.changeSetName===fixed.name&&equal(result.current,current)&&equal(result.artifact,artifact)
  &&result.executionAdmissible===false&&result.deployed===false&&result.phiAllowed===false,'publication_binding');
 check(equal(view.template,input.template)&&sha256(canonical(view.summary))===result.projection.summarySha256
  &&sha256(canonical(view.detailed))===result.projection.propertyValuesSha256
  &&view.summary.ExecutionStatus==='AVAILABLE'&&view.detailed.ExecutionStatus==='AVAILABLE','publication_changed');
 check(equal(verifyCatalogRuntimePredecessorControl(raw,JSON.parse(sourceText)),result.projection.predecessorControl),'control_changed');
}
export async function proposeCatalogRuntimeLive(root,options){
 catalogRuntimeObservationEnvironment(process.env);process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const witness=await verifyCatalogRuntimeOperatorApplication(root,options),c=context(root,options,witness);
 let custody;
 try{
  observeSyntheticMemberIdentity();const out=catalogRuntimeOperationDirectory(options.custodyRoot,c.current,c.candidate);
  verifyCatalogRuntimeSharedLocks(options.custodyRoot);custody=createIntentUploadCustody(options.custodyRoot,out,c.current,'catalog-runtime-artifact-proposal');
  const guard=()=>{c.unchanged();custody.verify();verifyCatalogRuntimeSharedLocks(options.custodyRoot,true);};
  custody.record({stage:'catalog_runtime_proposal_started',runId:custody.runId,operatorSource:c.operator});
  const artifact=await c.stored(),preparation=await c.preflight();guard();
  const result=await runCatalogRuntimeProposal(c.candidate,c.current,c.sourceText,preparation,artifact,{
   now:Date.now,identity:async()=>observeSyntheticMemberIdentity(),unchanged:async()=>guard(),
   refreshPreflight:c.preflight,control:observeCatalogRuntimeControlRaw,record:custody.record,admit:async e=>{guard();custody.admit(e);},
   list:async fixed=>listing(fixed),writeInput:async(fixed,input)=>{guard();const dir=folder(out,fixed);
    durable(resolve(dir,'template.json'),input.template);durable(resolve(dir,'parameters.json'),input.parameters);},
   create:async(fixed,input)=>{guard();const dir=folder(out,fixed);durable(resolve(dir,'template.json'),input.template);
    durable(resolve(dir,'parameters.json'),input.parameters);
    return aws(['cloudformation','create-change-set','--stack-name',fixed.stackId,'--change-set-name',fixed.name,'--change-set-type','UPDATE',
     '--client-token',fixed.digest,'--capabilities','CAPABILITY_IAM','--description',`Catalog runtime synthetic code ${c.current.desktop.commit}; PHI off; no schema change`,
     '--template-body','file://'+resolve(dir,'template.json').replaceAll('\\','/'),'--parameters','file://'+resolve(dir,'parameters.json').replaceAll('\\','/')]);},
   describe:async(binding,details)=>{guard();return aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,
    details?'--include-property-values':'--no-include-property-values','--no-paginate']);},template:async binding=>{guard();return views(binding).template;},
   wait:ms=>new Promise(done=>setTimeout(done,ms)),saveReport:async(fixed,report)=>{guard();durable(resolve(folder(out,fixed),sha256(canonical(report))+'.json'),report);},
  });
  check(equal(await c.stored(),artifact),'artifact_changed');guard();
  const finalViews=views({stackId:result.stackId,id:result.changeSetId}),finalControl=await observeCatalogRuntimeControlRaw();guard();
  verifyCatalogRuntimeProposalPublication(result,finalViews,finalControl,c.sourceText,c.candidate,c.current,artifact,Date.now());
  verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);
  const receipt=resolve(out,custody.runId+'.proposal.json');saveCatalogRuntimeReceipt(receipt,{runId:custody.runId,operatorSource:c.operator,...result});
  custody.record({stage:'catalog_runtime_proposal_completed',receipt});custody.settle();
  return {receipt,runId:custody.runId,journal:custody.journal,operatorSource:c.operator,...result,operatorCustodySettled:true};
 }catch(error){custody?.record({stage:'catalog_runtime_proposal_finding',code:registeredPreflightFailureCode(error),writeAdmitted:custody.admitted});throw error;}
 finally{c.close();custody?.close();}
}
export function verifyCatalogRuntimeProposalCustody(c,candidate,artifact,sourceText,now){
 const current=Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,candidate.manifest[k]]));
 const input=catalogRuntimeCodeTemplateInputs(sourceText,candidate,current,artifact),fixed=catalogRuntimeChangeSetBinding(input,current,artifact);
 check(Buffer.isBuffer(c.lockBytes)&&c.lockBytes.length>0&&c.lockBytes.length<=16384&&Buffer.isBuffer(c.journalBytes)
  &&c.journalBytes.length>0&&c.journalBytes.length<=1024*1024&&c.journalBytes.at(-1)===10,'custody_bytes');
 let lock,events;try{lock=JSON.parse(c.lockBytes.toString());events=c.journalBytes.toString().trimEnd().split('\n').map(s=>JSON.parse(s));}
 catch{refuseRegistered('catalog_runtime_proposal_custody_json');}
 check(c.lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))&&equal(Object.keys(lock).sort(),['desktop','mobile','pid','purpose','runId'])
  &&c.journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'custody_encoding');
 check(lock.purpose==='catalog-runtime-artifact-proposal'&&/^[a-f0-9]{32}$/.test(lock.runId)&&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&equal(lock.desktop,current.desktop)&&equal(lock.mobile,current.mobile),'custody_binding');
 const stages=['catalog_runtime_proposal_started','catalog_runtime_change_set_create_admitted','catalog_runtime_change_set_observed',
  'catalog_runtime_change_set_verified_unexecuted','catalog_runtime_proposal_completed','catalog_runtime_proposal_finding'];
 check(events.length>=2&&events.length<=6&&events[0].stage===stages[0]&&events[0].runId===lock.runId
  &&events[1].stage===stages[1]&&new Set(events.map(e=>e.stage)).size===events.length,'journal_scope');
 const suffix=events.slice(2).map(e=>e.stage);
 check([[],[stages[5]],[stages[2]],[stages[2],stages[5]],[stages[2],stages[3]],
  [stages[2],stages[3],stages[5]],[stages[2],stages[3],stages[4]],
  [stages[2],stages[3],stages[4],stages[5]]].some(s=>equal(s,suffix)),'journal_scope');
 const operator=events[0].operatorSource;assertCareRegisteredCurrent(operator);
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'journal_operator_binding');
 const observed=events.find(e=>e.stage===stages[2]),verified=events.find(e=>e.stage===stages[3]);
 if(observed)check(observed.name===fixed.name&&observed.reused===false&&typeof observed.id==='string'
  &&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(observed.id),'journal_observation');
 if(verified)check(verified.id===observed.id&&/^[a-f0-9]{64}$/.test(verified.summarySha256)
  &&/^[a-f0-9]{64}$/.test(verified.propertyValuesSha256),'journal_verification');
 let previous=-Infinity,index=-1;for(const e of events){const i=stages.indexOf(e.stage),t=Date.parse(e.at);
  check(i>index&&Number.isFinite(t)&&t>=previous&&t<=now,'journal_scope');index=i;previous=t;}
 if(events.at(-1).stage===stages[5])check(events.at(-1).writeAdmitted===true,'journal_scope');
 check(events[1].stackId===fixed.stackId&&events[1].name===fixed.name&&events[1].clientToken===fixed.digest
  &&Number.isFinite(now)&&now-previous>=60000,'admission_binding');
 return {lock,events,current,input,fixed,operator};
}
/** Test seams only, never caller-selected transports in either CLI. */
export async function runCatalogRuntimeProposalReconciliation(suppliedCandidate,suppliedArtifact,sourceText,suppliedCustody,port){
 const candidate=structuredClone(suppliedCandidate),artifact=structuredClone(suppliedArtifact);
 for(const k of ['bundle','zip','releaseBytes','manifestBytes'])candidate[k]=Buffer.from(candidate[k]);
 const custody={lockBytes:Buffer.from(suppliedCustody.lockBytes),journalBytes:Buffer.from(suppliedCustody.journalBytes)},
  failed=verifyCatalogRuntimeProposalCustody(custody,candidate,artifact,sourceText,port.now());
 const caller=structuredClone(await port.identity());assertSyntheticMemberIdentity(caller);
 const guard=async()=>{await port.unchanged();check(await port.writerStopped(failed.lock.pid)===true,'writer_active');
  const reread=await port.custody();check(reread.lockBytes.equals(custody.lockBytes)&&reread.journalBytes.equals(custody.journalBytes),'custody_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(equal(next,caller),'principal_changed');};
 await guard();const preparation=structuredClone(await port.preflight());verifyCatalogRuntimeUploadPreflight(preparation,candidate,failed.current,port.now());
 const observe=async()=>{
  await guard();check(equal(await port.storage(),artifact),'artifact_changed');const raw=await port.control();
  check(equal(verifyCatalogRuntimePredecessorControl(raw,JSON.parse(sourceText)),preparation.control),'control_changed');
  const listed=await port.list(failed.fixed);check(Array.isArray(listed?.Summaries)&&!listed.NextToken&&listed.Summaries.length<=2000
   &&listed.Summaries.every(s=>typeof s.ChangeSetName==='string'&&typeof s.ChangeSetId==='string')
   &&new Set(listed.Summaries.map(s=>s.ChangeSetId)).size===listed.Summaries.length,'listing');
  const found=listed.Summaries.filter(s=>s.ChangeSetName===failed.fixed.name);check(found.length<=1,'ambiguous');
  if(!found.length)return {state:'absent_at_observation'};
  const binding={...failed.fixed,id:found[0].ChangeSetId},view=await port.views(binding);
  const projection=verifyCatalogRuntimeProposalViews(view.summary,view.detailed,view.template,failed.input,binding,raw,sourceText,
   preparation,failed.current,candidate,artifact,port.now());return {state:'verified_unexecuted',binding,projection};
 };
 const first=structuredClone(await observe()),second=await observe();check(equal(first,second),'proposal_changed');await guard();
 check(equal(verifyCatalogRuntimePredecessorControl(await port.control(),JSON.parse(sourceText)),preparation.control),'control_changed');
 check(equal(await port.storage(),artifact),'artifact_changed');await guard();
 verifyCatalogRuntimeUploadPreflight(preparation,candidate,failed.current,port.now());
 return {contract:'synthetic-catalog-runtime-proposal-reconciliation/1',observedAt:new Date(port.now()).toISOString(),runId:failed.lock.runId,
  execution:'synthetic-staging',account:P.account,applicationSource:failed.current,originalOperatorSource:failed.operator,artifact,observation:first,
  originalCreateOutcome:'unknown',writerStopped:true,repeatedReadbackVerified:true,reportIsNotAuthority:true,
  retryPerformed:false,awsMutationPerformed:false,deployed:false,schemaChanged:false,recoveryRehearsed:false,hostedAcceptance:false,
  erasureAccepted:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
}
export async function reconcileCatalogRuntimeProposalLive(root,options){
 catalogRuntimeObservationEnvironment(process.env);process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const witness=await verifyCatalogRuntimeOperatorApplication(root,options),c=context(root,options,witness);let guard;
 try{
  observeSyntheticMemberIdentity();const shared=resolve(options.custodyRoot,'dist/synthetic-care-routing');verifyCatalogRuntimeSharedLocks(options.custodyRoot,true);
  guard=acquireRegisteredUploadReconciliationGuard(shared,c.operator);
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),saved=JSON.parse(lockBytes.toString());check(/^[a-f0-9]{32}$/.test(saved.runId),'run_id');
  const out=catalogRuntimeOperationDirectory(options.custodyRoot,c.current,c.candidate),journal=resolve(out,saved.runId+'.events.jsonl'),
   journalBytes=bounded(journal,1024*1024),artifact=await c.stored();
  const caller=observeSyntheticMemberIdentity();
  const unchanged=()=>{c.unchanged();guard.verify();verifyCatalogRuntimeSharedLocks(options.custodyRoot,true,true);
   check(equal(observeSyntheticMemberIdentity(),caller),'principal_changed');};
  const result=await runCatalogRuntimeProposalReconciliation(c.candidate,artifact,c.sourceText,{lockBytes,journalBytes},{
   now:Date.now,identity:async()=>observeSyntheticMemberIdentity(),unchanged:async()=>unchanged(),writerStopped:async pid=>stoppedUploadWriter(pid),
   custody:async()=>({lockBytes:bounded(lock,16384),journalBytes:bounded(journal,1024*1024)}),preflight:c.preflight,
   storage:c.stored,control:observeCatalogRuntimeControlRaw,list:async fixed=>listing(fixed),views:async binding=>views(binding),
  });
  unchanged();verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);check(stoppedUploadWriter(saved.pid),'writer_active');
  check(bounded(lock,16384).equals(lockBytes)&&bounded(journal,1024*1024).equals(journalBytes),'custody_changed');
  const archive=resolve(out,saved.runId+'.proposal-settled-lock.json'),receipt=resolve(out,saved.runId+'.proposal-reconciliation-'+sha256(canonical(result))+'.json');
  durable(archive,lockBytes);durable(receipt,{operatorSource:c.operator,...result});unchanged();
  check(bounded(lock,16384).equals(lockBytes)&&bounded(journal,1024*1024).equals(journalBytes),'custody_changed');
  unlinkSync(lock);return {archive,receipt,operatorSource:c.operator,...result,operatorCustodySettled:true};
 }finally{c.close();guard?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>{const args=process.argv.slice(2),reconcile=args.at(-1)==='--reconcile-fictional-catalog-runtime-proposal-only';
  const options=catalogRuntimeProposalArguments(args,reconcile);return reconcile?reconcileCatalogRuntimeProposalLive(process.cwd(),options):proposeCatalogRuntimeLive(process.cwd(),options);})
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
