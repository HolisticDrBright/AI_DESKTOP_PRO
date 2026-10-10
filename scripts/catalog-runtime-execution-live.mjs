/** Fixed synthetic code execution and read-only stopped-writer reconciliation.
 * No upload/proposal, route switch, schema replay, activation or paid builds. */
import {execFileSync} from 'node:child_process';
import {resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,sha256,normalizedText} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,readCareRegisteredCandidate,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCatalogRuntimeArtifactBinding} from './synthetic-catalog-runtime-release.mjs';
import {catalogRuntimeProposalArguments,verifyCatalogRuntimeOperatorApplication} from './catalog-runtime-proposal-live.mjs';
import {catalogRuntimeObservationEnvironment,observeCatalogRuntimePreflight,inspectCatalogRuntimePredecessorSources} from './inspect-synthetic-catalog-runtime-release.mjs';
import {catalogRuntimeOperationDirectory,verifyCatalogRuntimeCustodyRoot,verifyCatalogRuntimeCustodyLocation,
 verifyCatalogRuntimeSharedLocks,verifyCatalogRuntimeUploadPreflight} from './catalog-runtime-upload.mjs';
import {catalogRuntimeCodeTemplateInputs,catalogRuntimeChangeSetBinding} from './catalog-runtime-code-change.mjs';
import {runCatalogRuntimeExecution,verifyCatalogRuntimeBeforeExecution,verifyCatalogRuntimeDeployment} from './catalog-runtime-deployment.mjs';
import {catalogRuntimeExecutionAdmission,runCatalogRuntimeExecutionReconciliation} from './catalog-runtime-execution-custody.mjs';
import {observeCatalogRuntimeControlRaw} from './catalog-runtime-control-observer.mjs';
import {createIntentUploadCustody} from './upload-synthetic-care-intent-release.mjs';
import {REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {inspectRegisteredUploadObject,acquireRegisteredUploadReconciliationGuard,stoppedUploadWriter} from './reconcile-synthetic-care-registered-upload.mjs';
import {buildCareRegisteredDatabaseObserver,registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {downloadIntentFunction} from './care-intent-live.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_execution_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
export function catalogRuntimeExecutionArguments(args,reconcile=false){
 check(args.length===13&&args[12]===(reconcile?'--reconcile-fictional-catalog-runtime-execution-only':'--execute-fictional-catalog-runtime-code-only'),'arguments');
 return catalogRuntimeProposalArguments([...args.slice(0,12),'--prepare-fictional-catalog-runtime-code-change-only']);
}
function aws(args){
 catalogRuntimeObservationEnvironment(process.env);
 try{const result=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return result.trim()?JSON.parse(result):{};}
 catch{refuseRegistered('catalog_runtime_execution_aws_unconfirmed');}
}
function bounded(file,max){const a=lstatSync(file);check(a.isFile()&&!a.isSymbolicLink()&&a.size>0&&a.size<=max,'file');
 const bytes=readFileSync(file),b=lstatSync(file);check(a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&bytes.length===a.size,'file_changed');return bytes;}
export function saveCatalogExecutionEvidence(file,value){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 check(bytes.length>0&&bytes.length<=2*1024*1024,'evidence_size');
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}catch(e){if(e?.code!=='EEXIST')throw e;}
 finally{if(fd!==undefined)closeSync(fd);}check(bounded(file,2*1024*1024).equals(bytes),'evidence_collision');return sha256(bytes);
}
export function readCatalogExecutionEvidence(out,file,kind){
 check(typeof file==='string'&&['before','admission'].includes(kind),'evidence_path');
 const name=basename(file),pattern=kind==='before'?/^before-[a-f0-9]{64}\.json$/:/^admission-[a-f0-9]{64}\.json$/;
 check(typeof file==='string'&&pattern.test(name)&&resolve(file).toLowerCase()===resolve(out,name).toLowerCase()
  &&realpathSync(file).toLowerCase()===resolve(out,name).toLowerCase(),'evidence_path');
 const bytes=bounded(file,kind==='before'?2*1024*1024:65536);check(name.includes(sha256(bytes)),'evidence_name');return bytes;
}
const views=b=>{const body=aws(['cloudformation','get-template','--stack-name',b.stackId,'--change-set-name',b.id,'--template-stage','Original']).TemplateBody;
 return {summary:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate']),
  detailed:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--include-property-values','--no-paginate']),
  template:typeof body==='string'?JSON.parse(body):body};};
async function context(root,options){
 catalogRuntimeObservationEnvironment(process.env);process.env.AWS_MAX_ATTEMPTS='1';process.env.AWS_RETRY_MODE='standard';process.env.AWS_PAGER='';
 const witness=await verifyCatalogRuntimeOperatorApplication(root,options),{operator,current,candidate}=witness;
 verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);
 const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT}),
  sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json');
 const unchanged=()=>{catalogRuntimeObservationEnvironment(process.env);verifyCatalogRuntimeCustodyLocation(root,options.custodyRoot);
  check(equal(careRegisteredCurrent(root,options.mobileRoot),operator)&&equal(careRegisteredCurrent(options.applicationRoot,options.mobileRoot),current),'source_changed');
  const reread=readCareRegisteredCandidate(options.directory);check(['bundle','zip','releaseBytes','manifestBytes'].every(k=>reread[k].equals(candidate[k])),'artifact_changed');};
 const storage=async()=>{unchanged();const result=await inspectRegisteredUploadObject(candidate,(command,opts={})=>client.send(command,
  {...opts,abortSignal:opts.abortSignal??AbortSignal.timeout(30000)}));unchanged();check(result.state==='stored_exact_version'&&result.bytesVerified===true,'storage');return result;};
 const artifact=async()=>{const result=await storage();return verifyCatalogRuntimeArtifactBinding(candidate,current,{bucket:P.bucket,key:candidate.manifest.key,
  versionId:result.versionId,sha256:result.sha256,bytes:result.bytes,reused:true,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true});};
 return {operator,current,candidate,sourceText,unchanged,storage,artifact,close:()=>client.destroy()};
}
export async function executeCatalogRuntimeLive(root,options){
 const c=await context(root,options);let custody;
 try{
  observeSyntheticMemberIdentity();const artifact=await c.artifact(),input=catalogRuntimeCodeTemplateInputs(c.sourceText,c.candidate,c.current,artifact),
   fixed=catalogRuntimeChangeSetBinding(input,c.current,artifact),listed=collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',fixed.stackId],'Summaries','NextToken'),
   matches=listed.Summaries.filter(s=>s.ChangeSetName===fixed.name);
  check(matches.length===1,'proposal_count');const binding={...fixed,id:matches[0].ChangeSetId},
   out=catalogRuntimeOperationDirectory(options.custodyRoot,c.current,c.candidate);
  verifyCatalogRuntimeSharedLocks(options.custodyRoot);custody=createIntentUploadCustody(options.custodyRoot,out,c.current,'catalog-runtime-artifact-execution');
  const guard=()=>{c.unchanged();custody.verify();verifyCatalogRuntimeSharedLocks(options.custodyRoot,true);observeSyntheticMemberIdentity();};
  custody.record({stage:'catalog_runtime_execution_started',runId:custody.runId,operatorSource:c.operator});
  const database=buildCareRegisteredDatabaseObserver(options.applicationRoot,c.current);let before,admittedAt,latestPreflight;
  const observeBefore=async()=>{guard();const observedDatabase=await database(),raw=await observeCatalogRuntimeControlRaw(),projected=views(binding);guard();
   const value={observedAt:new Date().toISOString(),raw,database:observedDatabase,input,binding,...projected},bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),
    file=resolve(out,'before-'+sha256(bytes)+'.json');saveCatalogExecutionEvidence(file,bytes);
   custody.record({stage:'catalog_runtime_execution_before_archived',file,sha256:sha256(bytes)});before=value;return value;};
  const observeAfter=async()=>{guard();const observedDatabase=await database(),raw=await observeCatalogRuntimeControlRaw(),projected=views(binding),
   codeBytes=await downloadIntentFunction(raw.fn,c.candidate);guard();return {after:{observedAt:new Date().toISOString(),raw,database:observedDatabase,...projected},codeBytes};};
  const started=Date.now(),result=await runCatalogRuntimeExecution(c.candidate,c.current,c.sourceText,artifact,{
   now:Date.now,current:async()=>{guard();return careRegisteredCurrent(options.applicationRoot,options.mobileRoot);},identity:async()=>observeSyntheticMemberIdentity(),custody:async()=>guard(),
   preflight:async()=>{latestPreflight=await observeCatalogRuntimePreflight(options.applicationRoot,options);guard();return latestPreflight;},
   storage:c.storage,before:observeBefore,record:custody.record,
   admit:async e=>{guard();check(before&&e.changeSetId===binding.id&&e.stackId===binding.stackId,'admission_binding');
    const admission=catalogRuntimeExecutionAdmission(before,c.current,artifact,c.operator,e.at,e.clientToken),bytes=Buffer.from(JSON.stringify(admission,null,2)+'\n'),
     file=resolve(out,'admission-'+sha256(bytes)+'.json');saveCatalogExecutionEvidence(file,bytes);
    custody.admit({...e,admissionFile:file,admissionSha256:sha256(bytes)});admittedAt=e.at;},
   execute:async(b,token)=>{guard();check(equal(b,binding)&&token===sha256(canonical({contract:'catalog-runtime-execution-input/1',binding,current:c.current,artifact})),'execution_binding');
    verifyCatalogRuntimeUploadPreflight(latestPreflight,c.candidate,c.current,Date.now());
    verifyCatalogRuntimeBeforeExecution(before,c.candidate,c.current,c.sourceText,artifact,started,Date.now());
    return aws(['cloudformation','execute-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--client-request-token',token]);},
   execution:async b=>{guard();check(equal(b,binding),'execution_binding');return {stack:aws(['cloudformation','describe-stacks','--stack-name',b.stackId]),
    changeSet:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate'])};},
   pause:ms=>new Promise(done=>setTimeout(done,ms)),after:observeAfter,
  });
  // A second complete readback is required before publication. The pure
  // result is not authority after storage/receipt I/O or source drift.
  check(equal(await c.artifact(),artifact),'artifact_changed');const final=await observeAfter(),w={contract:'synthetic-catalog-runtime-deployment-observation/1',
   current:c.current,artifact,executionAdmittedAt:admittedAt,before,after:final.after,codeBytes:final.codeBytes};
  const returned=verifyCatalogRuntimeDeployment(w,c.candidate,c.current,c.sourceText,artifact,started,Date.now());guard();
  const comparable=value=>{const copy=structuredClone(value);delete copy.observedAt;delete copy.replyLost;return copy;};
  check(equal(comparable(result),comparable(returned)),'publication_changed');
  verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);
  const receipt=resolve(out,custody.runId+'.execution.json');saveCatalogExecutionEvidence(receipt,{runId:custody.runId,operatorSource:c.operator,...returned,replyLost:result.replyLost});
  guard();verifyCatalogRuntimeDeployment(w,c.candidate,c.current,c.sourceText,artifact,started,Date.now());
  custody.record({stage:'catalog_runtime_execution_completed',receipt});custody.settle();
  return {receipt,runId:custody.runId,journal:custody.journal,operatorSource:c.operator,...returned,replyLost:result.replyLost,operatorCustodySettled:true};
 }catch(error){custody?.record({stage:'catalog_runtime_execution_finding',code:registeredPreflightFailureCode(error),writeAdmitted:custody.admitted});throw error;}
 finally{c.close();custody?.close();}
}
export async function reconcileCatalogRuntimeExecutionLive(root,options){
 const c=await context(root,options);let guard;
 try{
  observeSyntheticMemberIdentity();const shared=resolve(options.custodyRoot,'dist/synthetic-care-routing');verifyCatalogRuntimeSharedLocks(options.custodyRoot,true);
  guard=acquireRegisteredUploadReconciliationGuard(shared,c.operator);
  const lock=resolve(shared,'operator.lock'),lockBytes=bounded(lock,16384),saved=JSON.parse(lockBytes.toString());check(/^[a-f0-9]{32}$/.test(saved.runId),'run_id');
  const out=catalogRuntimeOperationDirectory(options.custodyRoot,c.current,c.candidate),journal=resolve(out,saved.runId+'.events.jsonl'),journalBytes=bounded(journal,1024*1024),
   artifact=await c.artifact(),database=buildCareRegisteredDatabaseObserver(root,c.operator),
   predecessor=inspectCatalogRuntimePredecessorSources(options.custodyRoot,options.frozenDesktopRoot,options.frozenMobileRoot),caller=observeSyntheticMemberIdentity();
  const unchanged=()=>{c.unchanged();guard.verify();verifyCatalogRuntimeSharedLocks(options.custodyRoot,true,true);
   check(equal(observeSyntheticMemberIdentity(),caller),'principal_changed');};
  const result=await runCatalogRuntimeExecutionReconciliation(c.candidate,artifact,c.sourceText,{lockBytes,journalBytes},c.operator,{
   now:Date.now,evidence:async(file,kind)=>readCatalogExecutionEvidence(out,file,kind),unchanged:async()=>unchanged(),
   identity:async()=>observeSyntheticMemberIdentity(),writerStopped:async pid=>stoppedUploadWriter(pid),
   custody:async()=>({lockBytes:bounded(lock,16384),journalBytes:bounded(journal,1024*1024)}),storage:c.artifact,database,
   control:observeCatalogRuntimeControlRaw,views:async b=>views(b),download:async(fn,state)=>{
    check(['AVAILABLE','EXECUTE_COMPLETE'].includes(state),'execution_unsettled');return downloadIntentFunction(fn,state==='AVAILABLE'?predecessor:c.candidate);},
  });
  unchanged();verifyCatalogRuntimeCustodyRoot(root,options.custodyRoot);check(stoppedUploadWriter(saved.pid),'writer_active');
  check(bounded(lock,16384).equals(lockBytes)&&bounded(journal,1024*1024).equals(journalBytes),'custody_changed');
  const archive=resolve(out,saved.runId+'.execution-settled-lock.json'),receipt=resolve(out,saved.runId+'.execution-reconciliation-'+sha256(canonical(result))+'.json');
  saveCatalogExecutionEvidence(archive,lockBytes);saveCatalogExecutionEvidence(receipt,result);unchanged();
  check(bounded(lock,16384).equals(lockBytes)&&bounded(journal,1024*1024).equals(journalBytes),'custody_changed');
  unlinkSync(lock);return {archive,receipt,...result,operatorCustodySettled:true};
 }finally{c.close();guard?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>{const args=process.argv.slice(2),reconcile=args.at(-1)==='--reconcile-fictional-catalog-runtime-execution-only',
  options=catalogRuntimeExecutionArguments(args,reconcile);return reconcile?reconcileCatalogRuntimeExecutionLive(process.cwd(),options):executeCatalogRuntimeLive(process.cwd(),options);})
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
