/** One fixed synthetic custody spans upload, proposal, execution, exact
 * successor verification and actual older-code routing recovery. No schema
 * replay, fixture writes, report-loading or paid mobile build option. */
import {execFileSync} from 'node:child_process';
import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {S3Client} from '@aws-sdk/client-s3';
import {fromIni} from '@aws-sdk/credential-provider-ini';
import {CARE_RELEASE as P,normalizedText,sha256} from './synthetic-care-release.mjs';
import {careRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {uploadCareRegisteredRelease,REGISTERED_UPLOAD_TRANSPORT} from './upload-synthetic-care-registered-release.mjs';
import {proposeCareRegisteredLive} from './prepare-synthetic-care-registered-code-change.mjs';
import {observeCareRegisteredPreflight,buildCareRegisteredDatabaseObserver,registeredPreflightFailureCode} from './prepare-synthetic-care-registered-release.mjs';
import {careRegisteredCodeTemplateInputs,careRegisteredChangeSetBinding} from './care-registered-code-change.mjs';
import {observeIntentControlRaw,downloadIntentFunction} from './care-intent-live.mjs';
import {inspectRegisteredUploadObject} from './reconcile-synthetic-care-registered-upload.mjs';
import {runCareRegisteredExecution,verifyCareRegisteredDeployment} from './care-registered-deployment.mjs';
import {runCareRegisteredLiveRecovery} from './care-registered-routing-live.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {observeSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('runner_'+code);};
export function registeredReleaseArguments(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--release-fictional-registered-with-fresh-recovery'
  &&[a[1],a[3]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
function aws(args){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{const text=execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}});return text.trim()?JSON.parse(text):{};
 }catch{refuseRegistered('runner_aws_unconfirmed');}
}
function save(file,value){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(e){if(e?.code!=='EEXIST')throw e;}finally{if(fd!==undefined)closeSync(fd);}
 const stat=lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===bytes.length&&readFileSync(file).equals(bytes),'evidence_readback');
 return sha256(bytes);
}
const views=b=>{
 const template=aws(['cloudformation','get-template','--stack-name',b.stackId,'--change-set-name',b.id,'--template-stage','Original']).TemplateBody;
 return {summary:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate']),
  detailed:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--include-property-values','--no-paginate']),
  template:typeof template==='string'?JSON.parse(template):template};
};
/** Save-before-admission and record-before-write ordering is enforced by the
 * orchestrator. Every production port below is constructed here, not loaded
 * from a receipt, environment, mock transport or command-line target. */
export async function releaseCareRegisteredLive(root,mobileRoot,directory){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 const uploaded=await uploadCareRegisteredRelease(root,mobileRoot,directory,async c=>{
  const {candidate,current,artifact}=c,sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json'),
   input=careRegisteredCodeTemplateInputs(sourceText,candidate,current,artifact),database=buildCareRegisteredDatabaseObserver(root,current);
  const proposal=await proposeCareRegisteredLive(root,c,mobileRoot,directory),fixed=careRegisteredChangeSetBinding(input,current,artifact),
   binding={...fixed,id:proposal.changeSetId};
  const client=new S3Client({region:P.region,credentials:fromIni({profile}),maxAttempts:1,requestHandler:REGISTERED_UPLOAD_TRANSPORT});
  let savedBefore,executionAdmittedAt,admission;
  const guard=async()=>{check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
   await c.unchanged();c.verify();observeSyntheticMemberIdentity();};
  const observeBefore=async()=>{await guard();const observedDatabase=await database(),raw=observeIntentControlRaw(),projected=views(binding);
   await guard();const before={observedAt:new Date().toISOString(),raw,database:observedDatabase,input,binding,...projected};
   const file=resolve(c.operationsDirectory,candidate.manifest.zipSha256+'.before-'+sha256(canonical(before))+'.json'),digest=save(file,before);
   await c.record({stage:'registered_execution_before_archived',file,sha256:digest});savedBefore=before;return before;
  };
  const observeAfter=async()=>{await guard();const observedDatabase=await database(),raw=observeIntentControlRaw(),projected=views(binding),
   codeBytes=await downloadIntentFunction(raw.fn,candidate);await guard();
   return {after:{observedAt:new Date().toISOString(),raw,database:observedDatabase,...projected},codeBytes};};
  try{
   const executionStarted=Date.now(),deployment=await runCareRegisteredExecution(candidate,current,sourceText,artifact,{
    now:Date.now,current:async()=>{await guard();return careRegisteredCurrent(root,mobileRoot);},
    identity:async()=>observeSyntheticMemberIdentity(),custody:async()=>{c.verify();},
    preflight:()=>observeCareRegisteredPreflight(root,mobileRoot,directory),
    storage:()=>inspectRegisteredUploadObject(candidate,(command,options={})=>client.send(command,
     {...options,abortSignal:options.abortSignal??AbortSignal.timeout(30000)})),before:observeBefore,record:c.record,
    admit:async e=>{await guard();check(savedBefore&&e.changeSetId===binding.id&&e.stackId===binding.stackId,'admission_binding');
     admission={...e,beforeSha256:sha256(canonical(savedBefore)),artifact,current};
     const file=resolve(c.operationsDirectory,candidate.manifest.zipSha256+'.execution-admission-'+sha256(canonical(admission))+'.json');
     save(file,admission);await c.admit({...e,admissionFile:file,admissionSha256:sha256(canonical(admission))});executionAdmittedAt=e.at;},
    execute:async(b,token)=>aws(['cloudformation','execute-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--client-request-token',token]),
    execution:async b=>{await guard();return {stack:aws(['cloudformation','describe-stacks','--stack-name',b.stackId]),
     changeSet:aws(['cloudformation','describe-change-set','--stack-name',b.stackId,'--change-set-name',b.id,'--no-include-property-values','--no-paginate'])};},
    pause:ms=>new Promise(done=>setTimeout(done,ms)),after:observeAfter,
   });
   const deploymentFile=resolve(c.operationsDirectory,'deployment-'+sha256(canonical(deployment))+'.json');save(deploymentFile,deployment);
   await c.record({stage:'registered_deployment_readback_archived',file:deploymentFile});
   const recovery=await runCareRegisteredLiveRecovery(root,mobileRoot,{candidate,current,artifact,sourceText,latest:deployment.latest},
    {verify:c.verify,record:c.record,admit:async e=>{await guard();await c.admit(e);}});
   // Routing returns to a new observed API deployment. Re-read raw services;
   // never patch the pre-recovery report to match the returned stage.
   const final=await observeAfter(),witness={contract:'synthetic-care-registered-deployment-observation/1',current,artifact,
    executionAdmittedAt,before:savedBefore,after:final.after,codeBytes:final.codeBytes},
    returned=verifyCareRegisteredDeployment(witness,candidate,current,sourceText,artifact,executionStarted,Date.now());
   const evidence={contract:'synthetic-care-registered-live-code-recovery/1',observedAt:new Date().toISOString(),
    current,artifact,admission,deployment,returned,recovery,reportIsNotAuthority:true,
    deployed:true,recoveryRehearsed:true,schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,
    physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
   const file=resolve(c.operationsDirectory,'code-recovery-'+sha256(canonical(evidence))+'.json');save(file,evidence);
   await guard();await c.record({stage:'registered_code_recovery_completed',file});
   return {directory:c.operationsDirectory,evidenceFile:file,...evidence};
  }finally{client.destroy();}
 },true);
 check(uploaded.operatorCustodySettled===true&&uploaded.proposal?.contract==='synthetic-care-registered-live-code-recovery/1'
  &&uploaded.proposal.deployed===true&&uploaded.proposal.recoveryRehearsed===true,'terminal_report');
 const {proposal:codeRecovery,...upload}=uploaded;
 return {contract:'synthetic-care-registered-live-run/1',runId:upload.runId,receipt:upload.receipt,journal:upload.journal,
  upload,codeRecovery,operatorCustodySettled:true,deployed:true,recoveryRehearsed:true,
  schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,releaseAccepted:false,
  physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>registeredReleaseArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>releaseCareRegisteredLive(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(registeredPreflightFailureCode(e));process.exitCode=1;});
}
