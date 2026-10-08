/** Fixed current-history upload and unexecuted proposal. No execution,
 * database replay, provider activation or paid mobile build is exposed. */
import {execFileSync} from 'node:child_process';
import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync,mkdirSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P,normalizedText,sha256} from './synthetic-care-release.mjs';
import {refuseRegistered} from './synthetic-care-registered-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {verifyCareRegisteredPredecessorControl,verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {observeIntentControlRaw} from './care-intent-live.mjs';
import {uploadCareRegisteredRelease,verifyRegisteredUploadPreflight} from './upload-synthetic-care-registered-release.mjs';
import {registeredPreflightFailureCode,observeCareRegisteredPreflight} from './prepare-synthetic-care-registered-release.mjs';
import {observeSyntheticMemberIdentity,assertSyntheticMemberIdentity,SYNTHETIC_MEMBER_PROFILE as profile} from './synthetic-aws-principal.mjs';
import {collectCancellationInventory} from './verify-synthetic-care-cancellation.mjs';
import {careRegisteredCodeChangeInputs,careRegisteredChangeSetBinding,verifyCareRegisteredProposalViews} from './care-registered-code-change.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('proposal_'+code);};
export function careRegisteredProposalArguments(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--artifact'&&a[4]==='--prepare-fictional-registered-code-change-only'
  &&[a[1],a[3]].every(v=>typeof v==='string'&&v.trim()&&!v.startsWith('--')),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
/** Actual observers only in the CLI; test transports cannot be selected by
 * a user argument, report file or flag. Unknown create is never replayed. */
export async function runCareRegisteredProposal(candidate,current,sourceText,preparation,artifact,port){
 const source=JSON.parse(sourceText),input=careRegisteredCodeChangeInputs(sourceText,candidate,current,preparation,artifact,port.now()),
  fixed=careRegisteredChangeSetBinding(input,current,artifact);
 const first=await port.identity();assertSyntheticMemberIdentity(first);
 let activePreparation=preparation,renewals=0;
 const unchangedPrincipal=async()=>{
  await port.unchanged();const caller=await port.identity();assertSyntheticMemberIdentity(caller);
  check(canonical(caller)===canonical(first),'principal_changed');
 };
 const guard=async(allowRenewal=true)=>{
  await unchangedPrincipal();
  // Renew only elapsed time, never a caught validation failure. The public
  // constructor performs a complete new read-only preflight, not a timestamp
  // edit, stored report or replay of an admitted create.
  const time=Date.parse(activePreparation.observedAt),now=port.now();
  if(Number.isFinite(time)&&Number.isFinite(now)&&now-time>120000){
   check(allowRenewal&&typeof port.refreshPreflight==='function'&&renewals<4,'preflight_renewal_required');
   const started=port.now(),fresh=await port.refreshPreflight();
   await unchangedPrincipal();verifyRegisteredUploadPreflight(fresh,candidate,current,port.now());
   check(Date.parse(fresh.observedAt)>=started&&canonical(fresh.control)===canonical(preparation.control),'preflight_renewal_changed');
   verifyCareRegisteredDatabase(fresh.databaseBefore,current,started,port.now());
   verifyCareRegisteredDatabase(fresh.databaseAfter,current,started,port.now());
   activePreparation=fresh;renewals++;
  }
  verifyRegisteredUploadPreflight(activePreparation,candidate,current,port.now());
  const raw=await port.control();check(canonical(verifyCareRegisteredPredecessorControl(raw,source))===canonical(activePreparation.control),'control_changed');
  await unchangedPrincipal();verifyRegisteredUploadPreflight(activePreparation,candidate,current,port.now());return raw;
 };
 await guard();
 const listing=await port.list(fixed);
 check(Array.isArray(listing?.Summaries)&&listing.Summaries.length<=2000&&!listing.NextToken
  &&listing.Summaries.every(s=>typeof s.ChangeSetName==='string'&&typeof s.ChangeSetId==='string')
  &&new Set(listing.Summaries.map(s=>s.ChangeSetId)).size===listing.Summaries.length,'listing');
 const found=listing.Summaries.filter(s=>s.ChangeSetName===fixed.name);check(found.length<=1,'ambiguous');
 await port.writeInput(fixed,input);await guard();let id=found[0]?.ChangeSetId;
 if(!id){
  port.admit({stage:'registered_change_set_create_admitted',stackId:fixed.stackId,name:fixed.name,clientToken:fixed.digest});
  const created=await port.create(fixed,input);check(created?.StackId===fixed.stackId,'created_identity');id=created.Id;
 }
 check(typeof id==='string'&&new RegExp('^arn:aws:cloudformation:'+P.region+':'+P.account+':changeSet/'+fixed.name+'/[A-Za-z0-9-]{1,128}$').test(id),'identity');
 const binding={...fixed,id};port.record({stage:'registered_change_set_observed',id,name:fixed.name,reused:found.length===1});
 let detailed;
 for(let n=0;n<20;n++){
  detailed=await port.describe(binding,true);
  if(!['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(detailed?.Status))break;
  await port.wait(2000);
 }
 const summary=await port.describe(binding,false),actualTemplate=await port.template(binding),raw=await guard();
 const projection=verifyCareRegisteredProposalViews(summary,detailed,actualTemplate,input,binding,raw,sourceText,
  activePreparation,current,candidate,artifact,port.now());
 const report={contract:'synthetic-care-registered-code-change/1',observedAt:new Date(port.now()).toISOString(),
  execution:'synthetic-staging',account:P.account,region:P.region,current,artifact,projection,
  stackId:fixed.stackId,changeSetId:id,changeSetName:fixed.name,changeSetCreated:found.length===0,reused:found.length===1,
  preflightObservedAt:activePreparation.observedAt,preflightSha256:sha256(canonical(activePreparation)),preflightRenewals:renewals,
  changeSetExecutionStatus:detailed.ExecutionStatus,executionAdmissible:false,deployed:false,schemaChanged:false,
  recoveryRehearsed:false,hostedAcceptance:false,releaseAccepted:false,phiAllowed:false,paidMobileBuildStarted:false};
 await port.saveReport(fixed,report);await guard(false);port.record({stage:'registered_change_set_verified_unexecuted',
  id,summarySha256:projection.summarySha256,propertyValuesSha256:projection.propertyValuesSha256});return report;
}
function aws(args){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 try{return JSON.parse(execFileSync('aws',[...args,'--profile',profile,'--region',P.region,'--output','json','--no-cli-pager'],
  {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe'],
   env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_RETRY_MODE:'standard',AWS_PAGER:''}}));}
 catch{refuseRegistered('proposal_aws_unconfirmed');}
}
function durable(file,value){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
 catch(error){if(error?.code!=='EEXIST')throw error;}
 finally{if(fd!==undefined)closeSync(fd);}
 const stat=lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===bytes.length
  &&readFileSync(file).equals(bytes),'file_readback');
}
export async function prepareCareRegisteredCodeChange(root,mobileRoot,directory){
 check(!Object.entries(process.env).some(([k,v])=>/^AWS_ENDPOINT_URL(?:_|$)/.test(k)&&v),'endpoint_override');
 return uploadCareRegisteredRelease(root,mobileRoot,directory,c=>proposeCareRegisteredLive(root,c,mobileRoot,directory));
}
/** Internal live composition, never a caller-supplied proposal report. */
export async function proposeCareRegisteredLive(root,c,mobileRoot,directory){
  const sourceText=normalizedText(root,'infra/aws-clinical-core/identity-api-extension.json');let out;
  const folder=fixed=>{
   const name=resolve(c.operationsDirectory,'proposal-'+fixed.digest);
   try{mkdirSync(name,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
   const stat=lstatSync(name);check(stat.isDirectory()&&!stat.isSymbolicLink(),'directory');out=name;return out;
  };
  const proposed=await runCareRegisteredProposal(c.candidate,c.current,sourceText,c.preparation,c.artifact,{
   now:Date.now,identity:async()=>observeSyntheticMemberIdentity(),unchanged:c.unchanged,
   refreshPreflight:()=>observeCareRegisteredPreflight(root,mobileRoot,directory),
   control:async()=>observeIntentControlRaw(),record:c.record,admit:c.admit,
   list:async fixed=>collectCancellationInventory(aws,['cloudformation','list-change-sets','--stack-name',fixed.stackId],'Summaries','NextToken'),
   writeInput:async(fixed,input)=>{durable(resolve(folder(fixed),'template.json'),input.template);durable(resolve(folder(fixed),'parameters.json'),input.parameters);},
   create:async(fixed,input)=>{
    durable(resolve(folder(fixed),'template.json'),input.template);durable(resolve(folder(fixed),'parameters.json'),input.parameters);
    return aws(['cloudformation','create-change-set','--stack-name',fixed.stackId,'--change-set-name',fixed.name,
    '--change-set-type','UPDATE','--client-token',fixed.digest,'--capabilities','CAPABILITY_IAM',
    '--description',`Registered synthetic code ${c.current.desktop.commit}; PHI off; no schema change`,
    '--template-body','file://'+resolve(folder(fixed),'template.json').replaceAll('\\','/'),
    '--parameters','file://'+resolve(folder(fixed),'parameters.json').replaceAll('\\','/')]);},
   describe:async(binding,details)=>aws(['cloudformation','describe-change-set','--stack-name',binding.stackId,'--change-set-name',binding.id,
    details?'--include-property-values':'--no-include-property-values','--no-paginate']),
   template:async binding=>{const value=aws(['cloudformation','get-template','--stack-name',binding.stackId,
    '--change-set-name',binding.id,'--template-stage','Original']).TemplateBody;return typeof value==='string'?JSON.parse(value):value;},
   wait:ms=>new Promise(done=>setTimeout(done,ms)),
   saveReport:async(fixed,report)=>durable(resolve(folder(fixed),sha256(canonical(report))+'.json'),report),
  });
  return {directory:out,...proposed};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careRegisteredProposalArguments(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>prepareCareRegisteredCodeChange(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(registeredPreflightFailureCode(error));process.exitCode=1;});
}
