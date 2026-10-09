/** Fresh observer pipeline, never an approval/report-loading API. Injected ports are unit tests only. */
import {CARE_RELEASE as P,refuseCareRelease as fail} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,verifyRecoveryPhase,verifyRecoveryMetric,
 verifyRecoveryIntegration,verifyRecoveryStage} from './care-recovery-routing.mjs';
const check=(ok,code)=>{if(!ok)fail('erasure_release_'+code);};
export function verifyCareErasureRecovery(r,source,started,now){
 check(r?.contract==='synthetic-care-retained-routing-rehearsal/1'&&r.scope==='preupgrade-retained-routing-only'
  &&r.execution==='synthetic-staging'&&r.account===P.account&&r.retainedVersion===R.version&&r.verdict==='pass'
  &&['functionalRoutingRecoveryVerified','returnToCandidateVerified','temporaryPermissionRemoved','originalRoutingRestored'].every(k=>r[k]===true)
  &&['schemaChanged','afterUpgradeVerified','terminalReceiptRecoveryVerified','upgradeAuthorized','fullJourneyAcceptance',
   'physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'].every(k=>r[k]===false),'recovery_scope');
 check(source?.clean===true&&/^[a-f0-9]{40}$/.test(source.commit??'')&&/^[a-f0-9]{64}$/.test(source.sha256??'')
  &&canonical(r.harness)===canonical(source),'source_binding');
 const begin=Date.parse(r.startedAt),end=Date.parse(r.completedAt);
 check(Number.isFinite(started)&&Number.isFinite(now)&&Number.isFinite(begin)&&Number.isFinite(end)
  &&begin>=started&&end>=begin&&end<=now&&now-end<=300000,'fresh_recovery_required');
 const all=['baseline','retained','returned'].flatMap(k=>verifyRecoveryPhase(r.observations?.[k]));
 check(new Set(all.map(o=>o.requestId)).size===60,'request_replay');
 const metric=r.metricWitness;
 check(Number.isSafeInteger(metric?.start)&&Number.isSafeInteger(metric.end)&&metric.minimum===20
  &&metric.start>=Math.floor(begin/60000)*60000&&metric.end<=Math.ceil(end/60000)*60000&&metric.end>metric.start,'metric_window');
 verifyRecoveryMetric(metric.response,metric.start,metric.end,20);
 const w=r.transportWitness;
 check(w&&[w.originalDeployment,w.retainedDeployment,w.returnedDeployment].every(v=>typeof v==='string'&&/^[a-z0-9]{1,20}$/.test(v))
  &&new Set([w.originalDeployment,w.retainedDeployment,w.returnedDeployment]).size===3,'deployment_binding');
 verifyCareErasureRestoredTransport(w.restored,w.restored,w.returnedDeployment);
 const b=r.baselineDatabase;
 check(b?.liveCount===46&&b.sourceCount===45&&b.tableCount===87&&b.liveLedger===P.liveBefore&&b.referenceLedger===P.reference
  &&Number.isSafeInteger(b.rows)&&b.rows>=0&&/^[a-f0-9]{64}$/.test(b.dataSha256??''),'database_binding');
 return b;
}
export function verifyCareErasureRestoredTransport(actual,expected,deployment){
 verifyRecoveryIntegration(actual?.integration,R.latestArn);verifyRecoveryStage(actual?.stage);
 check(actual.policy===null&&actual.stage.DeploymentId===deployment
  &&typeof actual.revisionId==='string'&&actual.revisionId.length>0
  &&['routesSha256','authorizersSha256','otherIntegrationsSha256','latestPolicySha256'].every(k=>/^[a-f0-9]{64}$/.test(actual[k]??''))
  &&canonical(actual)===canonical(expected),'restored_transport_drift');
}
function verifySchema(r,command,b){
 const after=command==='upgrade'||command==='postinspect';
 check(r?.contract==='care-erasure-schema-upgrade/1'&&r.execution==='synthetic-staging'&&r.phiAllowed===false
  &&r.command===(command==='postinspect'?'inspect':command)&&r.awsAccountId===P.account&&r.foundation===P.foundation
  &&r.observedMigrationCount===(after?47:46)&&r.sourceMigrationCount===(after?46:45)&&r.tableCount===(after?88:87)
  &&r.fromLedgerSha256===P.liveBefore&&r.toLedgerSha256===P.liveAfter&&r.referenceLedgerSha256===P.reference
  &&r.dataPreserved===true&&r.rowCount===b.rows&&r.originalRowCount===b.rows&&r.originalDataSha256===b.dataSha256
  &&/^[a-f0-9]{64}$/.test(r.dataSha256??'')&&(command==='postinspect'||r.dataSha256===b.dataSha256)
  &&r.rolledBack===(command==='rehearse')&&r.applied===(command==='upgrade')&&r.alreadyApplied===(command==='postinspect'),'schema_'+command);
 return r;
}
/** Called only by the actual runner's in-lock continuation. Every port in the CLI
 * is a live observer; saved JSON, environment success flags and target overrides have no path. */
export async function releaseCareErasure(suppliedRecovery,d){
 const recovery=structuredClone(suppliedRecovery),source=structuredClone(await d.source()),b=verifyCareErasureRecovery(recovery,source,d.started,d.now());
 const unchanged=async()=>{check(canonical(await d.source())===canonical(source),'source_changed');};
 const restored=async()=>{await unchanged();verifyCareErasureRecovery(recovery,source,d.started,d.now());
  verifyCareErasureRestoredTransport(await d.transport(),recovery.transportWitness.restored,recovery.transportWitness.returnedDeployment);};
 const schema=async command=>{const value=await d.schema(command==='postinspect'?'inspect':command);
  check(value?.operatorSource?.sourceCommit===source.commit&&value.operatorSource.clean===true,'schema_source');
  return verifySchema(value,command,b);};
 await restored();const before=await schema('inspect');
 await unchanged();const rehearsal=await schema('rehearse');
 await restored();const committed=await schema('upgrade');
 await unchanged();const after=await schema('postinspect');
 // Schema has changed; do not rerun the pre-upgrade observer. Verify the returned
 // transport only, and leave post-upgrade receipt journeys explicitly outstanding.
 verifyCareErasureRestoredTransport(await d.transport(),recovery.transportWitness.restored,recovery.transportWitness.returnedDeployment);
 return {contract:'synthetic-care-erasure-release/1',execution:'synthetic-staging',account:P.account,source,
  recoveryStartedAt:recovery.startedAt,recoveryCompletedAt:recovery.completedAt,before,rehearsal,committed,after,
  schemaChanged:true,preservationVerified:true,historicalAliasPreserved:true,originalRoutingRestored:true,
  postUpgradeJourneyVerified:false,terminalReceiptRecoveryVerified:false,fullJourneyAcceptance:false,
  qualificationEvidence:false,activationEvidence:false,phiAllowed:false,paidMobileBuildStarted:false};
}
