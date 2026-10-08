import {CARE_RELEASE as P,sha256} from '../synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from '../verify-deployed-synthetic-care.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical} from '../care-recovery-routing.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES} from '../verify-synthetic-care-consumer.mjs';
import {careIntentMigrationBinding,createCareIntentCandidate} from '../synthetic-care-intent-release.mjs';
import {careIntentDependencyFixture} from './care-intent-dependency.mjs';
const hash='b'.repeat(64),start=1700000000000,clone=structuredClone;
const flags=(keys,value)=>Object.fromEntries(keys.map(k=>[k,value]));
export function careIntentContinuationFixture(){
 const snapshot={commit:'a'.repeat(40),clean:true,sha256:hash,files:10};
 const current={desktop:snapshot,mobile:{source:{...snapshot,commit:'c'.repeat(40)},
  ...flags(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'],hash),
  built:false,deviceVerified:false},migrations:careIntentMigrationBinding(process.cwd()),templateSha256:hash};
 const candidate=createCareIntentCandidate(current,Buffer.from('exports.handler=async()=>({statusCode:503});'));
 const b=careIntentDependencyFixture(),newCode={...b.before.Properties.Code,S3Key:candidate.manifest.key,S3ObjectVersion:'fictional-version'};
 b.input.parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=candidate.manifest.key;
 b.after.Properties.Code=newCode;b.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(b.after);
 for(const item of b.detailed.Changes[0].ResourceChange.Details)item.Target.AfterValue=newCode[item.Target.Path.split('/').at(-1)];
 b.summary.Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=candidate.manifest.key;
 b.detailed.Parameters=clone(b.summary.Parameters);
 Object.assign(b.live.fn,{Version:'$LATEST',CodeSize:D.bytes,PackageType:'Zip',EphemeralStorage:{Size:512},TracingConfig:{Mode:'PassThrough'}});
 const stage={StageName:'$default',AutoDeploy:true,DeploymentId:'original',LastDeploymentStatusMessage:"Successfully deployed stage with deployment ID 'original'",
  DefaultRouteSettings:{DetailedMetricsEnabled:true,ThrottlingBurstLimit:20,ThrottlingRateLimit:10},
  AccessLogSettings:{DestinationArn:`arn:aws:logs:${P.region}:${P.account}:log-group:/ai-clinical-core/synthetic-staging/api-access`,
   Format:'{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength"}'}};
 const control={codeSha256:b.live.fn.CodeSha256,revision:b.live.fn.RevisionId,routeCount:51,iamVerified:true,loggingVerified:true,phiAllowed:false,
  ...flags(['routesSha256','authorizersSha256','integrationsSha256','stageSha256','policySha256','roleSha256'],hash),
  templateSha256:sha256(canonical(b.live.template))};
 const baseline={contract:'care-erasure-intent-upgrade/1',command:'inspect',operatorSource:{sourceCommit:current.desktop.commit,clean:true},
  awsAccountId:P.account,foundation:P.foundation,execution:'synthetic-staging',phiAllowed:false,observedMigrationCount:47,
  sourceMigrationCount:46,tableCount:88,rowCount:23985,dataSha256:'1'.repeat(64),schemaSha256:'2'.repeat(64),
  originalDataSha256:'1'.repeat(64),originalRowCount:23985,completeDataSha256:'1'.repeat(64),completeRowCount:23985,intentRowCount:0,
  fromLedgerSha256:current.migrations.liveBefore,toLedgerSha256:current.migrations.liveAfter,referenceLedgerSha256:current.migrations.reference,
  dataPreserved:true,schemaPreserved:true,...flags(['applied','alreadyApplied','rolledBack','canonicalRegistered','hostedAcceptance',
   'recoveryAcceptance','activationApproved','rollbackReadback','lastingUpgradeAvailable','apiDeploymentPerformed','recoveryDrillPerformed',
   'acceptance','phiActivation'],false)};
 const artifact={bucket:P.bucket,key:candidate.manifest.key,versionId:'fictional-version',sha256:candidate.manifest.zipSha256,
  bytes:candidate.zip.length,encryption:'aws:kms',kmsKeyArn:P.keyArn,exactVersionReadbackVerified:true,reused:false};
 const preparation={contract:'synthetic-care-intent-preparation/1',observedAt:new Date(start).toISOString(),account:P.account,region:P.region,
  execution:'synthetic-staging',desktop:current.desktop,mobile:current.mobile,predecessor:candidate.manifest.predecessor,
  candidateZipSha256:candidate.manifest.zipSha256,predecessorExactVersionReadback:true,sourceRebuiltNow:true,control,database:baseline,
  ...flags(['awsMutationPerformed','candidateUploaded','deployed','schemaChanged','canonicalRegistered','freshCompatibleRecoveryPerformed',
   'lastingSchemaUpgradeAuthorized','hostedAcceptance','paidMobileBuildStarted','phiAllowed'],false)};
 const latest={...clone(b.live.fn),RevisionId:'new-revision',CodeSha256:Buffer.from(candidate.manifest.zipSha256,'hex').toString('base64'),CodeSize:candidate.zip.length};
 const returnedStage={...clone(stage),DeploymentId:'returned',LastDeploymentStatusMessage:"Successfully deployed stage with deployment ID 'returned'"};
 const transport={integration:clone(b.live.integration),stage:returnedStage,policy:null,revisionId:latest.RevisionId,
  ...flags(['routesSha256','authorizersSha256','otherIntegrationsSha256','latestPolicySha256'],hash)};
 const after={fn:latest,template:clone(b.input.template),integration:clone(b.live.integration),resources:clone(b.live.resources),stage:returnedStage,transport,
  control:{...control,revision:latest.RevisionId,codeSha256:latest.CodeSha256,templateSha256:sha256(canonical(b.input.template))},
  stack:{Stacks:[{StackId:b.binding.stackId,StackName:P.stack,StackStatus:'UPDATE_COMPLETE',Parameters:clone(b.summary.Parameters)}]},
  changeSet:{ChangeSetId:b.binding.id,StackId:b.binding.stackId,Status:'CREATE_COMPLETE',ExecutionStatus:'EXECUTE_COMPLETE'}};
 const deployment={observedAt:new Date(start+20000).toISOString(),current,artifact,codeBytes:candidate.zip,
  before:{...b,proposedTemplate:b.input.template,stage},after};
 let request=0;
 const cases=()=>Object.keys(PERSONA_EMAILS).flatMap((persona,i)=>[
  ...CARE_CONSUMER_CASES.map(c=>({persona,case:c.name,status:c.status,requestId:'gateway-request-'+(++request),bodySha256:hash,verified:true})),
  {persona,case:'existing_cancelled_receipt',erasureRequestId:`70000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
   outcome:'cancelled',status:200,requestId:'gateway-request-'+(++request),bodySha256:hash,verified:true}]);
 const recovery={contract:'synthetic-care-intent-routing-rehearsal/1',scope:'intent-code-before-schema',execution:'synthetic-staging',account:P.account,
  verdict:'pass',current,zipSha256:candidate.manifest.zipSha256,
  startedAt:new Date(start+1000).toISOString(),completedAt:new Date(start+20000).toISOString(),
  retained:{configuration:{...clone(latest),FunctionArn:R.latestArn+':2',Version:'2'},codeBytes:candidate.zip},
  databaseBefore:clone(baseline),databaseAfter:clone(baseline),observations:{baseline:cases(),retained:cases(),returned:cases()},
  metricWitness:{functionName:P.functionName,qualifier:'2',start:Math.floor(start/60000)*60000,end:Math.ceil((start+20000)/60000)*60000,minimum:25,
   response:{Label:'Invocations',Datapoints:[{Timestamp:new Date(Math.floor(start/60000)*60000).toISOString(),Sum:25,Unit:'Count'}]}},
  transportWitness:{originalDeployment:'original',retainedDeployment:'retained',returnedDeployment:'returned',restored:clone(transport)},
  functionalRoutingRecoveryVerified:true,returnToCandidateVerified:true,temporaryPermissionRemoved:true,originalRoutingRestored:true,
  ...flags(['schemaChanged','canonicalRegistered','hostedAcceptance','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'],false),
  preSchemaDenials:['baseline','retained'].flatMap(phase=>Object.keys(PERSONA_EMAILS).flatMap(persona=>
   ['prepare_erasure','discover_erasure_requests'].map(action=>({phase,persona,action,status:503,error:'service_unavailable',verified:true,
    requestId:'gateway-request-'+(++request),bodySha256:hash}))))};
 let applied=false,time=start+25000;const calls=[];
 const supplied={candidate,current,artifact,preparation,deployment,recovery};
 const d={started:start,now:()=>time,current:async()=>{calls.push('current');return clone(current);},
  transport:async()=>{calls.push('transport');return clone(transport);},record:async x=>{calls.push(x.stage);},admit:async x=>{calls.push(x.stage);},
  schema:async command=>{calls.push(command);const prior=applied;if(command==='upgrade')applied=true;
   return {...clone(baseline),command,observedMigrationCount:applied?48:47,sourceMigrationCount:applied?47:46,
    dataSha256:applied&&command!=='upgrade'?'3'.repeat(64):baseline.dataSha256,
    completeDataSha256:applied?'3'.repeat(64):baseline.dataSha256,
    tableCount:applied?89:88,applied:command==='upgrade',alreadyApplied:prior,rolledBack:command==='rehearse'};}};
 return {supplied,d,calls,transport,advance:ms=>time+=ms};
}
