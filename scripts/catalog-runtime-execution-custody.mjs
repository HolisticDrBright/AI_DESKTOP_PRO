/** Stopped execution observation, not a retry or saved-report authority.
 * Injected ports are fictional tests; the live command builds its own reads. */
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {assertCareRegisteredCurrent,refuseRegistered} from './synthetic-care-registered-release.mjs';
import {verifyCatalogRuntimeCandidate,verifyCatalogRuntimeArtifactBinding} from './synthetic-catalog-runtime-release.mjs';
import {catalogRuntimeCodeTemplateInputs,catalogRuntimeChangeSetBinding,verifyCatalogRuntimeUnexecutedProposalViews} from './catalog-runtime-code-change.mjs';
import {verifyCatalogRuntimeBeforeExecution,verifyCatalogRuntimeReconciledDeployment} from './catalog-runtime-deployment.mjs';
import {verifyCatalogRuntimePredecessorControl} from './catalog-runtime-preflight.mjs';
import {verifyCareRegisteredDatabase} from './care-registered-preflight.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {assertSyntheticMemberIdentity} from './synthetic-aws-principal.mjs';
const check=(ok,code)=>{if(!ok)refuseRegistered('catalog_runtime_execution_custody_'+code);};
const equal=(a,b)=>canonical(a)===canonical(b);
const exact=(o,fields)=>o&&typeof o==='object'&&!Array.isArray(o)&&equal(Object.keys(o).sort(),[...fields].sort());
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const snapshot=c=>{const copy=structuredClone(c);for(const k of ['bundle','zip','releaseBytes','manifestBytes'])copy[k]=Buffer.from(copy[k]);return copy;};
const currentFrom=c=>Object.fromEntries(['desktop','mobile','migrations','templateSha256'].map(k=>[k,c.manifest[k]]));
const journalFields={
 catalog_runtime_execution_started:['runId','operatorSource'],catalog_runtime_execution_before_archived:['file','sha256'],
 catalog_runtime_change_execute_admitted:['stackId','changeSetId','clientToken','admissionFile','admissionSha256'],
 catalog_runtime_change_execute_reply_unconfirmed:['changeSetId'],catalog_runtime_change_execute_terminal:['changeSetId','replyLost'],
 catalog_runtime_deployed_bytes_control_verified:['changeSetId','revision','zipSha256'],
 catalog_runtime_execution_completed:['receipt'],catalog_runtime_execution_finding:['code','writeAdmitted'],
};
export function catalogRuntimeExecutionAdmission(before,current,artifact,operator,at,token){
 assertCareRegisteredCurrent(current);assertCareRegisteredCurrent(operator);
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'operator_binding');
 const expected=sha256(canonical({contract:'catalog-runtime-execution-input/1',binding:before.binding,current,artifact}));
 check(token===expected&&Number.isFinite(Date.parse(at)),'admission_binding');
 return {contract:'synthetic-catalog-runtime-execution-admission/1',executionAdmittedAt:at,current:structuredClone(current),
  artifact:structuredClone(artifact),operatorSource:structuredClone(operator),beforeSha256:sha256(canonical(before)),
  binding:structuredClone(before.binding),clientToken:token,sourceTemplateSha256:current.templateSha256};
}
/** Validate exact ordered durable witnesses, including a hard crash with no
 * finding row. These only bind historical admission to fresh later observations. */
export async function verifyCatalogRuntimeExecutionCustody(suppliedCandidate,suppliedArtifact,sourceText,suppliedCustody,now,readEvidence){
 const candidate=snapshot(suppliedCandidate),artifact=structuredClone(suppliedArtifact),current=currentFrom(candidate),
  lockBytes=Buffer.from(suppliedCustody.lockBytes),journalBytes=Buffer.from(suppliedCustody.journalBytes);
 verifyCatalogRuntimeCandidate(candidate,current);verifyCatalogRuntimeArtifactBinding(candidate,current,artifact);
 check(lockBytes.length>0&&lockBytes.length<=16384&&journalBytes.length>0&&journalBytes.length<=1024*1024
  &&journalBytes.at(-1)===10&&typeof readEvidence==='function','bytes');
 let lock,events;try{lock=JSON.parse(lockBytes.toString());events=journalBytes.toString().trimEnd().split('\n').map(s=>JSON.parse(s));}
 catch{refuseRegistered('catalog_runtime_execution_custody_json');}
 check(exact(lock,['runId','pid','purpose','desktop','mobile'])&&lock.purpose==='catalog-runtime-artifact-execution'
  &&typeof lock.runId==='string'&&/^[a-f0-9]{32}$/.test(lock.runId)&&Number.isSafeInteger(lock.pid)&&lock.pid>0
  &&equal(lock.desktop,current.desktop)&&equal(lock.mobile,current.mobile)
  &&lockBytes.equals(Buffer.from(JSON.stringify(lock)+'\n'))
  &&journalBytes.equals(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n')+'\n')),'binding');
 check(events.length>=4&&events.length<=9&&Number.isFinite(now),'journal_scope');
 let prior=-Infinity;for(const e of events){const time=Date.parse(e.at);
  check(Object.hasOwn(journalFields,e.stage)&&exact(e,['at','stage',...journalFields[e.stage]])
   &&Number.isFinite(time)&&time>=prior&&time<=now,'journal_fields');prior=time;
 }
 check(now-prior>=60000,'writer_settlement');
 const finding=events.at(-1).stage==='catalog_runtime_execution_finding'?events.at(-1):undefined;
 if(finding)check(finding.writeAdmitted===true&&typeof finding.code==='string'
  &&(finding.code==='synthetic_member_principal_refused'||/^synthetic_care_registered_release_refused:[a-z0-9_]{1,180}$/.test(finding.code)),'finding');
 const rows=finding?events.slice(0,-1):events;let at=0;
 const take=stage=>{const row=rows[at++];check(row?.stage===stage,'journal_order');return row;};
 const started=take('catalog_runtime_execution_started');check(started.runId===lock.runId,'run_id');
 const operator=structuredClone(started.operatorSource);assertCareRegisteredCurrent(operator);
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'operator_binding');
 const befores=[];for(let i=0;i<2;i++){
  const row=take('catalog_runtime_execution_before_archived');check(digest(row.sha256)&&typeof row.file==='string','before_locator');
  const bytes=Buffer.from(await readEvidence(row.file,'before'));check(bytes.length>0&&bytes.length<=2*1024*1024&&sha256(bytes)===row.sha256,'before_bytes');
  let before;try{before=JSON.parse(bytes.toString());}catch{refuseRegistered('catalog_runtime_execution_custody_before_json');}
  check(bytes.equals(Buffer.from(JSON.stringify(before,null,2)+'\n'))&&Date.parse(before.observedAt)<=Date.parse(row.at),'before_encoding');
  befores.push(before);
 }
 const admitted=take('catalog_runtime_change_execute_admitted'),time=Date.parse(admitted.at),before=befores[1],
  input=catalogRuntimeCodeTemplateInputs(sourceText,candidate,current,artifact),fixed=catalogRuntimeChangeSetBinding(input,current,artifact);
 // The first complete observation is historical after an actual renewal.
 // Validate it at its archive boundary; only the final observation must
 // remain fresh at admission. Never rewrite either observed timestamp.
 verifyCatalogRuntimeBeforeExecution(befores[0],candidate,current,sourceText,artifact,Date.parse(started.at),Date.parse(rows[1].at));
 verifyCatalogRuntimeBeforeExecution(before,candidate,current,sourceText,artifact,Date.parse(started.at),time);
 const comparable=b=>{const copy=structuredClone(b);delete copy.observedAt;delete copy.database.observedAt;
  delete copy.raw.role.Role.RoleLastUsed;for(const group of copy.raw.logGroups.logGroups)delete group.storedBytes;return copy;};
 check(equal(comparable(befores[0]),comparable(before))&&equal(before.input,input)
  &&before.binding.stackId===fixed.stackId&&before.binding.name===fixed.name&&before.binding.digest===fixed.digest
  &&admitted.stackId===fixed.stackId&&admitted.changeSetId===before.binding.id,'before_binding');
 const expected=catalogRuntimeExecutionAdmission(before,current,artifact,operator,admitted.at,admitted.clientToken);
 check(typeof admitted.admissionFile==='string'&&digest(admitted.admissionSha256),'admission_locator');
 const admissionBytes=Buffer.from(await readEvidence(admitted.admissionFile,'admission'));
 check(admissionBytes.length>0&&admissionBytes.length<=65536&&sha256(admissionBytes)===admitted.admissionSha256
  &&admissionBytes.equals(Buffer.from(JSON.stringify(expected,null,2)+'\n')),'admission_bytes');
 if(rows[at]?.stage==='catalog_runtime_change_execute_reply_unconfirmed'){
  check(take('catalog_runtime_change_execute_reply_unconfirmed').changeSetId===before.binding.id,'reply_binding');
 }
 if(rows[at]?.stage==='catalog_runtime_change_execute_terminal'){
  const terminal=take('catalog_runtime_change_execute_terminal');check(terminal.changeSetId===before.binding.id
   &&typeof terminal.replyLost==='boolean'&&terminal.replyLost===rows.some(e=>e.stage==='catalog_runtime_change_execute_reply_unconfirmed'),'terminal_binding');
  if(rows[at]?.stage==='catalog_runtime_deployed_bytes_control_verified'){
   const verified=take('catalog_runtime_deployed_bytes_control_verified');check(verified.changeSetId===before.binding.id
    &&typeof verified.revision==='string'&&verified.revision.length>0&&verified.revision.length<=128
    &&verified.zipSha256===candidate.manifest.zipSha256,'verified_binding');
   if(rows[at]?.stage==='catalog_runtime_execution_completed'){
    check(typeof take('catalog_runtime_execution_completed').receipt==='string','receipt_locator');
   }
  }
 }
 check(at===rows.length,'journal_suffix');
 return {lock,events,current,operator,artifact,before,binding:before.binding,executionAdmittedAt:admitted.at,
  journalSha256:sha256(journalBytes),originalExecutionOutcome:'unconfirmed'};
}

/** Observe completion or a still-available proposal twice and at a final
 * boundary. Pending/partial/rollback states stay held. No execute/delete ports. */
export async function runCatalogRuntimeExecutionReconciliation(suppliedCandidate,suppliedArtifact,sourceText,suppliedCustody,suppliedOperator,port){
 const candidate=snapshot(suppliedCandidate),artifact=structuredClone(suppliedArtifact),operator=structuredClone(suppliedOperator),
  custody={lockBytes:Buffer.from(suppliedCustody.lockBytes),journalBytes:Buffer.from(suppliedCustody.journalBytes)},started=port.now();
 assertCareRegisteredCurrent(operator);
 const original=await verifyCatalogRuntimeExecutionCustody(candidate,artifact,sourceText,custody,started,port.evidence);
 const {current,before,binding}=original;
 check(equal(operator.mobile,current.mobile)&&equal(operator.migrations,current.migrations)
  &&operator.templateSha256===current.templateSha256,'operator_binding');
 const caller=structuredClone(await port.identity());assertSyntheticMemberIdentity(caller);
 const guard=async()=>{await port.unchanged();check(await port.writerStopped(original.lock.pid)===true,'writer_active');
  const actual=await port.custody();check(actual.lockBytes.equals(custody.lockBytes)&&actual.journalBytes.equals(custody.journalBytes),'custody_changed');
  const next=await port.identity();assertSyntheticMemberIdentity(next);check(equal(next,caller),'principal_changed');};
 const observe=async()=>{
  await guard();check(equal(await port.storage(),artifact),'storage_changed');
  const database=structuredClone(await port.database()),raw=structuredClone(await port.control()),view=structuredClone(await port.views(structuredClone(binding))),
   codeBytes=Buffer.from(await port.download(raw.fn,view.summary.ExecutionStatus));
  await guard();const now=port.now(),after={observedAt:new Date(now).toISOString(),raw,database,...view};
  if(view.summary.ExecutionStatus==='EXECUTE_COMPLETE'){
   const w={contract:'synthetic-catalog-runtime-deployment-observation/1',current,artifact,
    executionAdmittedAt:original.executionAdmittedAt,before,after,codeBytes};
   const proof=verifyCatalogRuntimeReconciledDeployment(w,candidate,current,sourceText,artifact,operator,started,now);
   return {state:'verified_deployed',w,proof};
  }
  check(view.summary.ExecutionStatus==='AVAILABLE'&&view.detailed.ExecutionStatus==='AVAILABLE','execution_unsettled');
  const control=verifyCatalogRuntimePredecessorControl(raw,JSON.parse(sourceText));
  verifyCatalogRuntimeUnexecutedProposalViews(view.summary,view.detailed,view.template,before.input,binding,raw,sourceText,
   control,current,candidate,artifact,now);
  const db=verifyCareRegisteredDatabase(database,operator,started,now),compare=d=>{const copy=structuredClone(d);
   delete copy.observedAt;delete copy.operatorSource;return copy;};
  check(equal(compare(db),compare(before.database))&&sha256(codeBytes)===candidate.release.predecessor.zipSha256
   &&codeBytes.length===candidate.release.predecessor.bytes,'predecessor_changed');
  return {state:'verified_unexecuted',observedAt:after.observedAt,control,database:compare(db),proposalSha256:sha256(canonical(view)),codeSha256:sha256(codeBytes)};
 };
 const comparable=o=>{const copy=structuredClone(o);delete copy.observedAt;
  if(copy.w){delete copy.w.after.observedAt;delete copy.w.after.database.observedAt;
   delete copy.w.after.raw.role.Role.RoleLastUsed;for(const group of copy.w.after.raw.logGroups.logGroups)delete group.storedBytes;
   delete copy.proof.observedAt;}return copy;};
 const first=await observe(),second=await observe();check(equal(comparable(first),comparable(second)),'observation_changed');
 const final=await observe();check(equal(comparable(second),comparable(final)),'observation_changed');
 await guard();check(equal(await port.storage(),artifact),'storage_changed');await guard();
 if(final.w)verifyCatalogRuntimeReconciledDeployment(final.w,candidate,current,sourceText,artifact,operator,started,port.now());
 else{const observed=Date.parse(final.observedAt);check(Number.isFinite(observed)&&observed<=port.now()
  &&port.now()-observed<=120000,'final_observation_expired');}
 return {contract:'synthetic-catalog-runtime-execution-reconciliation/1',observedAt:new Date(port.now()).toISOString(),
  runId:original.lock.runId,execution:'synthetic-staging',account:P.account,current,operatorSource:operator,artifact,
  observation:final.state,originalExecutionOutcome:'unconfirmed',repeatedReadbackVerified:true,writerStopped:true,
  reportIsNotAuthority:true,retryPerformed:false,awsMutationPerformed:false,deployed:final.state==='verified_deployed',
  compatibleRecoveryRequired:true,recoveryRehearsed:false,schemaChanged:false,hostedAcceptance:false,erasureAccepted:false,
  releaseAccepted:false,physicalDeviceAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
}
