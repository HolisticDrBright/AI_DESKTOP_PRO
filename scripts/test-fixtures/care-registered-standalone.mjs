/** Fictional transports only. None of these objects is hosted evidence. */
import {CARE_RELEASE as P,sha256} from '../synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from '../care-recovery-routing.mjs';
import {careRegisteredDeploymentFixture} from './care-registered-deployment.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES} from '../verify-synthetic-care-consumer.mjs';
import {intentRecoveryPermission} from '../care-intent-routing.mjs';
import {rehearseCareRegisteredRouting} from '../care-registered-routing.mjs';
export function careRegisteredStandaloneFixture(parse){
 const f=careRegisteredDeploymentFixture();f.now=f.completed+600000;f.operator=structuredClone(f.current);
 f.operator.desktop.commit='1'.repeat(40);f.operator.desktop.sha256='2'.repeat(64);
 f.after.database.operatorSource={sourceCommit:f.operator.desktop.commit,clean:true};
 const event=(stage,detail={},at=f.completed)=>({at:new Date(at).toISOString(),stage,...detail}),
  binding=f.before.binding,token=sha256(canonical({contract:'care-registered-execution-input/1',binding,current:f.current,artifact:f.artifact}));
 f.originLock={purpose:'registered-artifact-upload-release',pid:1234567,runId:'3'.repeat(32),desktop:f.current.desktop,mobile:f.current.mobile};
 const admission={at:f.witness.executionAdmittedAt,stage:'registered_change_execute_admitted',stackId:binding.stackId,changeSetId:binding.id,
  clientToken:token,beforeSha256:sha256(canonical(f.before)),artifact:f.artifact,current:f.current};
 f.originalFiles=new Map([['before',Buffer.from(JSON.stringify(f.before,null,2)+'\n')],['admission',Buffer.from(JSON.stringify(admission,null,2)+'\n')]]);
 f.originalEvents=[event('registered_upload_started',{runId:f.originLock.runId},f.started),
  event('registered_live_preflight_verified',{observedAt:new Date(f.started).toISOString()},f.started),
  event('registered_artifact_exact_version_verified',{artifact:f.artifact},f.started),
  event('registered_change_set_observed',{id:binding.id,name:binding.name,reused:true},f.started),
  event('registered_change_set_verified_unexecuted',{id:binding.id,summarySha256:sha256(canonical(f.before.summary)),propertyValuesSha256:sha256(canonical(f.before.detailed))},f.started),
  ...[1,2].map(()=>event('registered_execution_before_archived',{file:'before',sha256:sha256(f.originalFiles.get('before'))},Date.parse(f.before.observedAt))),
  event('registered_change_execute_admitted',{stackId:binding.stackId,changeSetId:binding.id,clientToken:token,
   admissionFile:'admission',admissionSha256:sha256(canonical(admission))},Date.parse(admission.at)),
  event('registered_change_execute_terminal',{changeSetId:binding.id,replyLost:false}),
  event('registered_deployed_bytes_control_verified',{changeSetId:binding.id,revision:f.after.raw.fn.RevisionId,zipSha256:f.candidate.manifest.zipSha256}),
  event('registered_deployment_readback_archived',{file:'deployment'}),
  event('registered_recovery_permission_admitted',{version:'2',sid:'alp-care-intent-recovery-'+'a'.repeat(32)}),
  event('registered_recovery_switch_admitted',{version:'2'}),
  event('registered_upload_finding',{code:'synthetic_care_registered_release_refused:routing_restoration_unconfirmed',writeAdmitted:true})];
 f.original={lockBytes:Buffer.from(JSON.stringify(f.originLock)+'\n'),journalBytes:Buffer.from(f.originalEvents.map(e=>JSON.stringify(e)).join('\n')+'\n')};
 f.origin={runId:f.originLock.runId,lockSha256:sha256(f.original.lockBytes),journalSha256:sha256(f.original.journalBytes)};
 f.lock={purpose:'registered-standalone-routing-rehearsal',pid:7654321,runId:'4'.repeat(32),
  applicationSource:f.current,operatorSource:f.operator,original:structuredClone(f.origin)};
 f.events=[];f.files=new Map();f.calls=[];f.sequence=0;f.policy=null;
 f.encode=()=>({lockBytes:Buffer.from(JSON.stringify(f.lock)+'\n'),journalBytes:Buffer.from(f.events.length?f.events.map(e=>JSON.stringify(e)).join('\n')+'\n':'')});
 f.custody=f.encode();const retained={configuration:{...structuredClone(f.before.raw.fn),Version:'2',FunctionArn:R.latestArn+':2'},
  sha256:f.candidate.release.predecessor.zipSha256,bytes:f.candidate.release.predecessor.bytes,policy:null};
 f.retained=retained;f.caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 f.port={now:()=>f.now,identity:async()=>structuredClone(f.caller),current:async()=>structuredClone(f.operator),
  applicationCurrent:async()=>structuredClone(f.current),writerStopped:async()=>true,
  originalCustody:async()=>({lockBytes:Buffer.from(f.original.lockBytes),journalBytes:Buffer.from(f.original.journalBytes)}),
  originalEvidence:async file=>f.originalFiles.get(file),custody:async()=>f.encode(),
  verifyLocal:bytes=>{if(!bytes.equals(f.encode().journalBytes))throw Error('local custody changed');},
  rebuild:async()=>({byteVerified:true,sourceRebuilt:true,zipSha256:f.candidate.manifest.zipSha256,
   desktopCommit:f.current.desktop.commit,mobileCommit:f.current.mobile.source.commit,liveTargetObserved:false,deployed:false,phiAllowed:false}),
  database:async()=>{f.calls.push('database');const value=structuredClone(f.after.database);value.observedAt=new Date(f.now).toISOString();return value;},
  control:async()=>{f.calls.push('control');return structuredClone(f.after.raw);},
  proposal:async()=>({summary:structuredClone(f.after.summary),detailed:structuredClone(f.after.detailed),template:structuredClone(f.after.template)}),
  latest:async()=>Buffer.from(f.candidate.zip),retained:async()=>structuredClone(f.retained),retainedPolicy:async()=>structuredClone(f.policy),
  storage:async()=>({state:'stored_exact_version',bytesVerified:true,versionId:f.artifact.versionId,
   sha256:f.candidate.manifest.zipSha256,bytes:f.candidate.manifest.zipBytes,deletionCertified:false}),
  apiDeployment:async id=>({DeploymentId:id,DeploymentStatus:'DEPLOYED'}),
  record:async e=>{f.events.push(e);return f.encode().journalBytes;},
  save:async(kind,bytes)=>{const file=kind+'-'+sha256(bytes);f.files.set(file,bytes);return file;},evidence:async file=>f.files.get(file),parseIntent:parse,
 };
 const personaIds=Object.keys(PERSONA_EMAILS).map((_,i)=>`${String(i+1).padStart(8,'0')}-0000-4000-8000-000000000001`);
 f.routing={now:()=>f.now,current:async()=>structuredClone(f.current),observerCurrent:async()=>structuredClone(f.operator),identity:f.port.identity,parseIntent:parse,
  inspect:async()=>({...structuredClone(f.after.database),observedAt:new Date(f.now).toISOString()}),
  transport:async()=>({raw:structuredClone(f.after.raw),policy:structuredClone(f.policy)}),retained:f.port.retained,
  consumerPhase:async phase=>{f.now+=1000;return Object.keys(PERSONA_EMAILS).flatMap((persona,i)=>CARE_CONSUMER_CASES.map((spec,j)=>({
   persona,case:spec.name,requestId:`consumer-${phase}-${i}-${j}`,status:spec.status,verified:true,bodySha256:'d'.repeat(64)})));},
  receiptPhase:async phase=>Object.keys(PERSONA_EMAILS).map((persona,i)=>({persona,case:'existing_cancelled_receipt',erasureRequestId:personaIds[i],
   requestId:`receipt-${phase}-${i}`,status:200,outcome:'cancelled',verified:true,bodySha256:'e'.repeat(64)})),
  intentPhase:async phase=>Object.keys(PERSONA_EMAILS).flatMap((persona,i)=>['discover_erasure_requests','prepare_erasure'].map(action=>{
   const value=action==='prepare_erasure'?{error:'request_invalid'}:{data:{action,items:[{requestId:personaIds[i],scope:'domain',outcome:'cancelled',
    receipt:null,intentRegistered:false,registeredAt:null,completedAt:'2026-10-08T05:00:00Z'}],next:null,legacyUncorrelatedErasureCount:0,
    coverage:'committed_owner_records_not_global_clearance'}};
   return {persona,phase,action,expectedRequestId:personaIds[i],requestId:`intent-${phase}-${i}-${action}`,
    status:action==='prepare_erasure'?400:200,value,bodySha256:sha256(canonical(value))};})),
  addPermission:async(sid,version)=>{f.calls.push('grant');f.policy={RevisionId:'fictional-permission',Policy:JSON.stringify({Version:'2012-10-17',Statement:[intentRecoveryPermission(sid,version)]})};},
  removePermission:async()=>{f.calls.push('remove');f.policy=null;},
  switchUri:async uri=>{f.calls.push(uri);f.after.raw.integrations.Items.find(v=>v.IntegrationId===R.integrationId).IntegrationUri=uri;
   f.after.raw.stage.DeploymentId='standalonestage'+ ++f.sequence;
   f.after.raw.stage.LastDeploymentStatusMessage=`Successfully deployed stage with deployment ID '${f.after.raw.stage.DeploymentId}'`;},
  waitDeployment:async()=>f.routing.transport(),
  waitMetric:async start=>({Label:'Invocations',Datapoints:[{Timestamp:new Date(start).toISOString(),Sum:35,Unit:'Count'}]})};
 f.port.recovery=async(input,c)=>{f.calls.push('recovery');return rehearseCareRegisteredRouting(input,{...f.routing,custody:async()=>c.verify(),record:c.record,admit:c.admit},c.recoverySid);};
 return f;
}
