/** Resume the fixed interrupted profile only after fresh service/source
 * reconciliation. No replay of upload, CFN execution or version publication. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {careIntentCurrent,refuseIntent} from './synthetic-care-intent-release.mjs';
import {canonical} from './care-recovery-routing.mjs';
import {observeCareIntentResumption} from './reconcile-synthetic-care-intent.mjs';
import {createCareIntentResumptionCustody} from './care-intent-resumption-custody.mjs';
import {careIntentResumptionInput,verifyCareIntentResumedDeployment} from './care-intent-resumption-deployment.mjs';
import {runCareIntentLiveRecovery} from './release-synthetic-care-intent.mjs';
import {releaseResumedCareIntent} from './care-intent-release.mjs';
import {intentFailureCode} from './upload-synthetic-care-intent-release.mjs';
const check=(ok,code)=>{if(!ok)refuseIntent('resume_'+code);};
export function careIntentResumeArgs(a){
 check(a.length===5&&a[0]==='--v2-root'&&a[2]==='--candidate'
  &&a[4]==='--resume-interrupted-fictional-intent-with-fresh-recovery'&&!a[1].startsWith('--')&&!a[3].startsWith('--'),'arguments');
 return {mobileRoot:resolve(a[1]),directory:resolve(a[3])};
}
export async function resumeCareIntentRelease(root,mobileRoot,directory){
 const observed=await observeCareIntentResumption(root,mobileRoot,directory);
 const {candidate,qualified,interruption,baseline,schema,started}=observed,{applicationCurrent:current,operatorCurrent}=qualified;
 const deployed=verifyCareIntentResumedDeployment(observed.deployment,candidate,current,operatorCurrent,started,Date.now());
 const custody=createCareIntentResumptionCustody(root,directory,interruption,candidate,current,operatorCurrent);
 const unchanged=()=>{custody.guard();observed.unchanged();};
 const record=custody.record,context={candidate,current,operatorCurrent,mobileRoot,
  preparation:{database:baseline,control:deployed.control},unchanged,record,admit:custody.admit,
  interruptedRetainedVersion:interruption.retainedVersion};
 const input=careIntentResumptionInput(observed.deployment.source,candidate,observed.deployment.artifact);
 const before={binding:interruption.binding,summary:observed.deployment.summary,
  live:{fn:observed.deployment.predecessor.configuration}};
 try{
  unchanged();record({stage:'fresh_services_reconciled',revision:deployed.latest.RevisionId,
   retainedVersion:interruption.retainedVersion,zipSha256:deployed.zipSha256});
  const {recovery,transport}=await runCareIntentLiveRecovery(root,context,before,input,observed.deployment.source,deployed.latest,schema,started);
  // Repeat the actual source, artifact, control and database readbacks. A saved
  // pre-switch stage is not patched to look like the returned deployment.
  unchanged();const returned=await observeCareIntentResumption(root,mobileRoot,directory);unchanged();
  check(canonical(returned.qualified)===canonical(qualified)&&canonical(returned.baseline)===canonical(baseline),'returned_binding_drift');
  const result=await releaseResumedCareIntent({candidate,current,operatorCurrent,baseline,deployment:returned.deployment,recovery},
   {started,now:Date.now,current:async()=>{unchanged();return careIntentCurrent(root,mobileRoot);},transport,schema,record,admit:custody.admit});
  const out=resolve(directory,'resumptions');mkdirSync(out,{recursive:true});
  const {codeBytes,...retained}=recovery.retained;
  const evidence={contract:'synthetic-care-intent-resumption-evidence/1',execution:'synthetic-staging',account:P.account,
   runId:custody.runId,parentRunId:interruption.runId,initialReconciliation:observed.result,returnedReconciliation:returned.result,
   recovery:{...recovery,retained},retainedDownloadSha256:sha256(codeBytes),schemaRelease:result,
   reportIsNotAuthority:true,hostedAcceptance:false,phiAllowed:false,paidMobileBuildStarted:false};
  const report=resolve(out,custody.runId+'.json');writeFileSync(report,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  // Recheck custody and restored transport before the original lock is retired.
  unchanged();const actual=await transport();
  check(canonical(actual)===canonical(recovery.transportWitness.restored),'settlement_transport_drift');
  record({stage:'resumed_release_verified',report,schemaChanged:true});custody.settle(result);
  return {contract:'synthetic-care-intent-resumption-run/1',runId:custody.runId,parentRunId:interruption.runId,
   report,...result,operatorCustodySettled:true,originalCustodyArchived:true};
 }catch(e){record({stage:'finding',code:intentFailureCode(e),writeAdmitted:custody.admitted});throw e;}
 finally{custody.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 Promise.resolve().then(()=>careIntentResumeArgs(process.argv.slice(2)))
  .then(({mobileRoot,directory})=>resumeCareIntentRelease(process.cwd(),mobileRoot,directory))
  .then(r=>console.log(JSON.stringify(r)))
  .catch(e=>{console.error(intentFailureCode(e));process.exitCode=1;});
}
