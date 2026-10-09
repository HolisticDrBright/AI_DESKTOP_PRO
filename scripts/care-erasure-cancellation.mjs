/** Cancellation-first hosted acceptance. Injectable ports are credential-free tests only. */
import {CARE_RELEASE as P,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {PERSONA_EMAILS} from './verify-synthetic-care-consumer.mjs';
import {canonical} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)fail('erasure_cancellation_'+code);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function careCancellationArgs(args){
 check(args.length===1&&args[0]==='--verify-fictional-cancellation-first','arguments');
}
export function verifyCancellationDatabase(r,source){
 check(r?.contract==='care-erasure-schema-upgrade/1'&&r.command==='inspect'&&r.execution==='synthetic-staging'
  &&r.awsAccountId===P.account&&r.foundation===P.foundation&&r.phiAllowed===false
  &&r.operatorSource?.sourceCommit===source.commit&&r.operatorSource.clean===true
  &&r.observedMigrationCount===47&&r.sourceMigrationCount===46&&r.tableCount===88
  &&r.fromLedgerSha256===P.liveBefore&&r.toLedgerSha256===P.liveAfter&&r.referenceLedgerSha256===P.reference
  &&r.alreadyApplied===true&&r.applied===false&&r.rolledBack===false&&r.dataPreserved===true
  &&r.acceptance===false&&r.phiActivation===false&&r.apiDeploymentPerformed===false
  &&Number.isSafeInteger(r.rowCount)&&Number.isSafeInteger(r.originalRowCount)&&r.rowCount>=r.originalRowCount
  &&r.originalRowCount>=0&&/^[a-f0-9]{64}$/.test(r.dataSha256??'')
  &&/^[a-f0-9]{64}$/.test(r.originalDataSha256??''),'database');
 return r;
}
export function verifyCancellationAnswer(input,outcome,response,value){
 check(uuid(input?.requestId)&&input.scope==='domain'
  &&['erase_receipt','settle_erasure','erase_request'].includes(input.action)
  &&['unresolved','cancelled'].includes(outcome),'case');
 check(response?.status===200&&value&&Object.keys(value).length===1&&Object.hasOwn(value,'data'),'answer');
 const data=value.data;
 check(data&&canonical(Object.keys(data).sort())===canonical(['action','outcome','receipt','requestId','scope'].sort())
  &&data.action===input.action&&data.scope===input.scope&&data.requestId===input.requestId
  &&data.outcome===outcome&&data.receipt===null,'answer');
 const requestId=response.headers?.get('apigw-requestid');
 check(typeof requestId==='string'&&/^[A-Za-z0-9_=+/-]{8,160}$/.test(requestId),'gateway_request');
 return {requestId,status:200,outcome,verified:true};
}
export function verifyCancellationStoredReceipt(rows){
 check(Array.isArray(rows)&&rows.length===1&&canonical(rows[0])===canonical({scope:'domain',outcome:'cancelled',receiptAbsent:true}),'stored_cancellation');
}
/** No erasure is admitted until cancellation is proved through both the actual
 * consumer API and an independent bounded SQL read. No fixture, consent, policy,
 * identity, routing, schema or clinical content is changed by these ports. */
export async function verifyCareCancellation(d){
 const source=structuredClone(await d.source());
 check(source.clean===true&&/^[a-f0-9]{40}$/.test(source.commit??'')&&/^[a-f0-9]{64}$/.test(source.sha256??''),'source');
 const before=verifyCancellationDatabase(await d.inspect(),source),control=structuredClone(await d.control());
 const modes=Object.keys(PERSONA_EMAILS),ids=new Set(),requests=new Set(),observations=[];
 const guard=async()=>{check(canonical(await d.source())===canonical(source),'source_changed');
  check(canonical(await d.control())===canonical(control),'control_changed');};
 const query=async(mode,session,label,id,action,outcome)=>{
  const input={action,scope:'domain',requestId:id};
  await d.record({stage:'case_admitted',persona:mode,case:label,erasureRequestId:id,action});
  const answer=await d.request(session,input);
  const observed=verifyCancellationAnswer(input,outcome,answer.response,answer.value);
  check(!requests.has(observed.requestId),'request_replay');requests.add(observed.requestId);
  const item={persona:mode,case:label,erasureRequestId:id,...observed};observations.push(item);
  await d.record({stage:'case_verified',...item});return item;
 };
 await guard();
 for(let i=0;i<modes.length;i++){
  const mode=modes[i],other=modes[(i+1)%modes.length],id=d.uuid();
  check(uuid(id)&&!ids.has(id),'request_id');ids.add(id);
  const first=await d.authenticate(mode),second=await d.authenticate(mode),stranger=await d.authenticate(other);
  check(first?.owner===second?.owner&&uuid(first.owner)&&uuid(stranger?.owner)&&stranger.owner!==first.owner
   &&typeof first.sessionId==='string'&&first.sessionId.length>=8&&typeof second.sessionId==='string'
   &&typeof stranger.sessionId==='string'&&new Set([first.sessionId,second.sessionId,stranger.sessionId]).size===3,'sessions');
  await query(mode,first,'absent_receipt',id,'erase_receipt','unresolved');
  // Guard immediately before the sole new-row write. No retry on an unknown response.
  await guard();
  await query(mode,first,'cancel_before_admission',id,'settle_erasure','cancelled');
  verifyCancellationStoredReceipt(await d.stored(first.owner,id));
  await d.record({stage:'stored_cancellation_verified',persona:mode,erasureRequestId:id});
  await query(mode,second,'second_session_receipt',id,'erase_receipt','cancelled');
  await query(mode,second,'idempotent_settle',id,'settle_erasure','cancelled');
  await guard();
  verifyCancellationStoredReceipt(await d.stored(first.owner,id));
  await query(mode,first,'late_admission_refused',id,'erase_request','cancelled');
  await query(mode,second,'second_session_after_late',id,'erase_receipt','cancelled');
  await query(mode,stranger,'cross_owner_receipt_absent',id,'erase_receipt','unresolved');
  verifyCancellationStoredReceipt(await d.stored(first.owner,id));
 }
 await guard();const after=verifyCancellationDatabase(await d.inspect(),source);
 check(after.originalRowCount===before.originalRowCount&&after.originalDataSha256===before.originalDataSha256
  &&after.rowCount===before.rowCount+5,'original_data_changed');
 check(observations.length===35&&requests.size===35,'case_inventory');
 return {contract:'synthetic-care-erasure-cancellation-acceptance/1',scope:'parent-cancellation-first-only',
  execution:'synthetic-staging',account:P.account,source,deployedSource:D.desktop,deployedZip:D.zip,
  before,after,control,observations,verdict:'pass',cancelFirstVerified:true,lateAdmissionRefusalVerified:true,
  secondAuthenticatedSessionVerified:true,crossOwnerReceiptIsolationVerified:true,originalDataPreserved:true,
  terminalCancellationRowsAdded:5,erasedOutcomeVerified:false,lostReplyErasureVerified:false,
  retainedRoutingRecoveryVerified:false,fullJourneyAcceptance:false,physicalDeviceAcceptance:false,
  qualificationEvidence:false,activationEvidence:false,phiAllowed:false,paidMobileBuildStarted:false};
}
