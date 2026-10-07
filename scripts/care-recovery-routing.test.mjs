import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {DEPLOYED_CARE as D} from './verify-deployed-synthetic-care.mjs';
import {PERSONA_EMAILS,CARE_CONSUMER_CASES} from './verify-synthetic-care-consumer.mjs';
import {CARE_RECOVERY_ROUTE as R,canonical,recoveryPermission,verifyRecoveryPolicy,verifyRecoveryIntegration,
 verifyRecoveryStage,verifyRecoveryMetric,rehearseCareRecovery,verifyRecoveryResponse} from './care-recovery-routing.mjs';
import {recoveryArgs,recoveryAwsOutput,recoveryMissingPolicy,verifyRecoveryLatestPolicy,verifyRecoveryInspector,recoveryFailureCode} from './rehearse-synthetic-care-routing.mjs';
const sid='alp-care-recovery-'+'a'.repeat(32),digest='b'.repeat(64);
function stage(id='original'){return {StageName:'$default',AutoDeploy:true,DeploymentId:id,
 LastDeploymentStatusMessage:`Successfully deployed stage with deployment ID '${id}'`,
 DefaultRouteSettings:{DetailedMetricsEnabled:true,ThrottlingBurstLimit:20,ThrottlingRateLimit:10},
 AccessLogSettings:{DestinationArn:`arn:aws:logs:${P.region}:${P.account}:log-group:/ai-clinical-core/synthetic-staging/api-access`,
 Format:'{"requestId":"$context.requestId","routeKey":"$context.routeKey","status":"$context.status","responseLength":"$context.responseLength"}'}};}
const integration=uri=>({IntegrationId:R.integrationId,IntegrationUri:uri,IntegrationType:'AWS_PROXY',IntegrationMethod:'POST',
 ConnectionType:'INTERNET',PayloadFormatVersion:'2.0',TimeoutInMillis:30000});
const policy=()=>({Policy:JSON.stringify({Version:'2012-10-17',Statement:[recoveryPermission(sid)]}),RevisionId:'own-policy-revision'});
function preflight(){return {source:D.desktop,zip:D.zip,s3Version:D.version,artifactVerified:true,iamVerified:true,loggingVerified:true,
 harness:{clean:true,commit:'a'.repeat(40),sha256:digest},database:{liveCount:46,sourceCount:45,tableCount:87,
 liveLedger:P.liveBefore,referenceLedger:P.reference,rows:1234,dataSha256:digest}};}
function fixture(){
 const calls=[],events=[];let time=1700000000000,requests=0,deployment=0;
 const state={integration:integration(R.latestArn),stage:stage(),policy:null,revisionId:'latest-revision',
 routesSha256:digest,authorizersSha256:digest,otherIntegrationsSha256:digest,latestPolicySha256:digest};
 const d={now:()=>time+=1000,inspect:async()=>{calls.push('inspect');return preflight();},
 transport:async()=>{calls.push('transport');return structuredClone(state);},
 record:async event=>{calls.push('record:'+event.stage);events.push(event);},
 addPermission:async id=>{assert.equal(id,sid);calls.push('add');state.policy=policy();},
 removePermission:async(id,revision)=>{assert.equal(id,sid);assert.equal(revision,'own-policy-revision');calls.push('remove');state.policy=null;},
 switchUri:async uri=>{calls.push('switch:'+uri);state.integration=integration(uri);state.stage=stage('deployment'+(++deployment));},
 waitDeployment:async(previous,uri)=>{calls.push('deployment');assert.notEqual(state.stage.DeploymentId,previous);
 assert.equal(state.integration.IntegrationUri,uri);return structuredClone(state);},
 consumerPhase:async phase=>{calls.push('consumers:'+phase);return Object.keys(PERSONA_EMAILS).flatMap(persona=>CARE_CONSUMER_CASES.map(spec=>
 ({persona,case:spec.name,status:spec.status,requestId:'request-'+(++requests),bodySha256:digest,verified:true})));},
 waitMetric:async(start,end,minimum)=>{calls.push('metric');assert.equal(minimum,20);assert.ok(end>start);
 return {Label:'Invocations',Datapoints:[{Timestamp:new Date(start).toISOString(),Sum:20,Unit:'Count'}]};}};
 return {d,state,calls,events};
}
const mutations=f=>f.calls.filter(c=>c==='add'||c==='remove'||c.startsWith('switch:'));

test('failure diagnostics preserve only bounded machine codes and fixed phases, never credentials or response text',()=>{
 for(const [error,at,expected] of [
 [{message:'synthetic_member_principal_refused'},'principal','recovery_principal_principal_refused'],
 [{message:'synthetic_care_release_refused:recovery_restoration_unconfirmed'},'rehearsal','recovery_restoration_unconfirmed'],
 [{message:'synthetic_care_consumer_refused:token_binding'},'rehearsal','recovery_consumer_token_binding'],
 [{code:'ETIMEDOUT',message:'secret command'},'source','recovery_source_timeout'],
 [{message:'synthetic_care_release_refused:token=fictional-secret'},'personas','recovery_personas_failed'],
 [{message:'synthetic_care_release_refused:allowed\nsecret'},'rehearsal','recovery_rehearsal_failed'],
 [{message:'sensitive health response'},'malicious phase','recovery_entry_failed'],
 [{name:'NotAuthorizedException',message:'credential response'},'retained_authenticate_regular_cycle','recovery_retained_authenticate_regular_cycle_not_authorized'],
 [{name:'TimeoutError',message:'network response'},'retained_regular_cycle_posture','recovery_retained_regular_cycle_posture_timeout'],
 [{name:'SyntaxError',message:'health body'},'returned_menopause_care_export','recovery_returned_menopause_care_export_invalid_json'],
 [{name:'DangerousServerPayload',message:'raw'},'retained_authenticate_regular_cycle','recovery_retained_authenticate_regular_cycle_failed'],
 ])assert.equal(recoveryFailureCode(error,at),'synthetic_care_release_refused:'+expected);
});

test('only the fixed synthetic confirmation argument is accepted; no target or success overrides',()=>{
 recoveryArgs(['--rehearse-existing-fictional-version']);
 for(const args of [[],['--approve'],['--rehearse-existing-fictional-version','--phi'],
 ['--rehearse-existing-fictional-version','--target','other']])assert.throws(()=>recoveryArgs(args));
});
test('AWS empty success is allowed only for remove-permission, never for observations',()=>{
 assert.deepEqual(recoveryAwsOutput(['lambda','remove-permission'],'\n'),{});
 assert.deepEqual(recoveryAwsOutput(['lambda','get-policy'],'{"Policy":"actual"}'),{Policy:'actual'});
 for(const args of [['lambda','get-policy'],['apigatewayv2','update-integration'],['cloudwatch','get-metric-statistics']])
 assert.throws(()=>recoveryAwsOutput(args,''));
 assert.throws(()=>recoveryAwsOutput(['lambda','remove-permission'],'not-json'));
});
test('fresh inspector artifact binds the clean source and embedded fixed history, not asserted digest alone',()=>{
 const bytes=Buffer.from('fictional-inspector'),harness={commit:'a'.repeat(40)},operator={contract:'care-erasure-schema-upgrade-build/1',
 sourceCommit:harness.commit,clean:true,execution:'synthetic-staging',phiAllowed:false,migrationPerformed:false,sourceMigrationCount:46,
 expectedLiveBefore:46,expectedLiveAfter:47,historicalAliasPreserved:true,mandatoryRollbackRehearsal:true,embeddedMigrations:true,
 embeddedReferenceMigrations:true,targetOverrides:false,sha256:sha256(bytes)};
 verifyRecoveryInspector(operator,bytes,harness);
 for(const [key,value] of Object.entries({contract:'other',sourceCommit:'c'.repeat(40),clean:false,execution:'production',phiAllowed:true,
 migrationPerformed:true,sourceMigrationCount:47,expectedLiveBefore:47,expectedLiveAfter:48,historicalAliasPreserved:false,
 mandatoryRollbackRehearsal:false,embeddedMigrations:false,embeddedReferenceMigrations:false,targetOverrides:true,sha256:digest}))
 assert.throws(()=>verifyRecoveryInspector({...operator,[key]:value},bytes,harness));
 assert.throws(()=>verifyRecoveryInspector(operator,Buffer.from('replacement'),harness));
});
test('missing permission requires the exact bounded AWS error and qualified read, not denied or unknown responses',()=>{
 const args=['lambda','get-policy','--function-name',P.functionName,'--qualifier','1'];
 for(const prefix of ['','aws: [ERROR]: '])assert.equal(recoveryMissingPolicy(args,{stderr:prefix+
 'An error occurred (ResourceNotFoundException) when calling the GetPolicy operation: not found'},true),true);
 for(const [a,e,allowed] of [[args,{stderr:'AccessDeniedException'},true],[args,{stderr:'ResourceNotFoundException'},true],
 [args,{stderr:'An error occurred (ResourceNotFoundException) when calling the GetPolicy operation:'+ 'x'.repeat(4096)},true],
 [args,{stderr:'An error occurred (ResourceNotFoundException) when calling the GetPolicy operation:'},false],
 [['lambda','get-policy'],{stderr:'An error occurred (ResourceNotFoundException) when calling the GetPolicy operation:'},true]])
 assert.equal(recoveryMissingPolicy(a,e,allowed),false);
});
test('permission never broadens API, account, action, principal or qualified version',()=>{
 verifyRecoveryPolicy(null,sid,false);verifyRecoveryPolicy(policy(),sid,true);
 for(const mutate of [s=>s.Resource=R.latestArn,s=>s.Action='*',s=>s.Principal.Service='*',
 s=>s.Condition.ArnLike['AWS:SourceArn']='*',s=>s.Condition.StringEquals['AWS:SourceAccount']='173535830222']){
 const p=policy(),body=JSON.parse(p.Policy);mutate(body.Statement[0]);p.Policy=JSON.stringify(body);
 assert.throws(()=>verifyRecoveryPolicy(p,sid,true));
 }
 const p=policy(),body=JSON.parse(p.Policy);body.Statement.push(body.Statement[0]);p.Policy=JSON.stringify(body);
 assert.throws(()=>verifyRecoveryPolicy(p,sid,true));assert.throws(()=>verifyRecoveryPolicy(policy(),sid,false));
 assert.throws(()=>verifyRecoveryPolicy(null,sid,true));assert.throws(()=>recoveryPermission('arbitrary'));
});
test('the original latest policy is independently validated and not widened',()=>{
 const statement={Sid:P.stack+'-IdentityApiInvokePermission-fictional',Effect:'Allow',Principal:{Service:'apigateway.amazonaws.com'},
 Action:'lambda:InvokeFunction',Resource:R.latestArn,Condition:{ArnLike:{'AWS:SourceArn':R.sourceArn}}};
 const make=()=>({Policy:JSON.stringify({Version:'2012-10-17',Statement:[statement]}),RevisionId:'latest-policy-revision'});
 verifyRecoveryLatestPolicy(make());
 for(const mutate of [p=>p.RevisionId='',p=>p.Policy='{}',p=>p.Policy=p.Policy.replace(R.latestArn,R.retainedArn),
 p=>p.Policy=p.Policy.replace('lambda:InvokeFunction','*')]){const p=make();mutate(p);assert.throws(()=>verifyRecoveryLatestPolicy(p));}
});
test('integration and successful auto-deployed stage must match the fixed bounds',()=>{
 verifyRecoveryIntegration(integration(R.latestArn),R.latestArn);verifyRecoveryStage(stage());
 for(const mutate of [s=>s.AutoDeploy=false,s=>s.StageName='production',s=>s.LastDeploymentStatusMessage='pending',
 s=>s.DefaultRouteSettings.ThrottlingBurstLimit=100,s=>s.RouteSettings={other:{}},s=>s.StageVariables={target:'other'},
 s=>s.AccessLogSettings.DestinationArn='other']){const s=stage();mutate(s);assert.throws(()=>verifyRecoveryStage(s));}
 for(const mutate of [i=>i.IntegrationUri='other',i=>i.TimeoutInMillis=29000,i=>i.RequestParameters={unexpected:'mapping'},
 i=>i.IntegrationId='other',i=>i.ApiGatewayManaged=true]){const i=integration(R.latestArn);mutate(i);assert.throws(()=>verifyRecoveryIntegration(i,R.latestArn));}
});
test('metric proof requires actual bounded version invocations, never missing/stale/duplicated datapoints',()=>{
 const start=1700000000000,end=start+60000;
 const make=()=>({Label:'Invocations',Datapoints:[{Timestamp:new Date(start).toISOString(),Sum:20,Unit:'Count'}]});
 assert.equal(verifyRecoveryMetric(make(),start,end,20),20);
 for(const mutate of [m=>m.Datapoints=[],m=>m.Label='Errors',m=>m.Datapoints[0].Sum=19,m=>m.Datapoints[0].Sum=-1,
 m=>m.Datapoints[0].Sum=20.5,m=>m.Datapoints[0].Unit='None',m=>m.Datapoints[0].Timestamp=new Date(end).toISOString(),
 m=>m.Datapoints.push({...m.Datapoints[0]}),m=>m.Datapoints=Array(31).fill(m.Datapoints[0])]){
 const m=make();mutate(m);assert.throws(()=>verifyRecoveryMetric(m,start,end,20));}
});
test('real response verification refuses substituted text, PHI or missing gateway request identity',()=>{
 const spec=CARE_CONSUMER_CASES[0],data={data:{contractVersion:'clinical-core/1',environment:'synthetic-staging',dataClassification:'synthetic_only',
 identityPool:'consumer',authenticated:true,phiAllowed:false,realPatientDataAllowed:false}};
 const response=new Response(null,{status:200,headers:{'apigw-requestid':'fictional-request'}});
 assert.equal(verifyRecoveryResponse(spec,response,data).verified,true);
 assert.throws(()=>verifyRecoveryResponse(spec,response,{error:'not_configured'}));
 assert.throws(()=>verifyRecoveryResponse(spec,response,{data:{...data.data,phiAllowed:true}}));
 assert.throws(()=>verifyRecoveryResponse(spec,new Response(null,{status:200}),data));
});
test('success is sixty distinct requests, observed deployments, version metrics and identical independent database reads',async()=>{
 const f=fixture(),result=await rehearseCareRecovery(f.d,sid);
 assert.equal(result.verdict,'pass');assert.equal(result.functionalRoutingRecoveryVerified,true);
 assert.equal(result.returnToCandidateVerified,true);assert.equal(result.temporaryPermissionRemoved,true);
 assert.equal(result.scope,'preupgrade-retained-routing-only');
 for(const k of ['afterUpgradeVerified','terminalReceiptRecoveryVerified','upgradeAuthorized','fullJourneyAcceptance','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])
 assert.equal(result[k],false);
 assert.equal(Object.values(result.observations).flat().length,60);
 assert.deepEqual(mutations(f),['add','switch:'+R.retainedArn,'switch:'+R.latestArn,'remove']);
 assert.equal(f.calls.filter(c=>c==='inspect').length,2);assert.equal(f.state.policy,null);
 assert.ok(f.events.findIndex(e=>e.stage==='permission_admitted')<f.events.findIndex(e=>e.stage==='switch_admitted'));
});
test('wrong source, object, database, schema, IAM, logs or dirty harness refuse before any AWS write',async()=>{
 for(const mutate of [p=>p.source='f'.repeat(40),p=>p.zip=digest,p=>p.s3Version='latest',p=>p.artifactVerified=false,
 p=>p.iamVerified=false,p=>p.loggingVerified=false,p=>p.harness.clean=false,p=>p.database.liveCount=47,
 p=>p.database.sourceCount=46,p=>p.database.liveLedger=P.liveAfter,p=>p.database.referenceLedger='f'.repeat(64),
 p=>p.database.tableCount=88,p=>p.database.dataSha256='',p=>p.database.rows=-1]){
 const f=fixture(),p=preflight();mutate(p);f.d.inspect=async()=>p;
 await assert.rejects(rehearseCareRecovery(f.d,sid));assert.deepEqual(mutations(f),[]);
 }
});
test('pre-existing permission or unbound transport cannot be treated as this run\'s grant',async()=>{
 for(const mutate of [s=>s.policy=policy(),s=>s.latestPolicySha256=undefined,s=>s.revisionId='',s=>s.integration.IntegrationUri=R.retainedArn]){
 const f=fixture();mutate(f.state);await assert.rejects(rehearseCareRecovery(f.d,sid));assert.deepEqual(mutations(f),[]);}
});
test('drift in latest policy, routes, authorizers, other integrations or revision refuses before grant',async()=>{
 for(const key of ['latestPolicySha256','routesSha256','authorizersSha256','otherIntegrationsSha256','revisionId']){
 const f=fixture(),consumer=f.d.consumerPhase;f.d.consumerPhase=async phase=>{const cases=await consumer(phase);f.state[key]='c'.repeat(64);return cases;};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/control_drift/);assert.deepEqual(mutations(f),[]);}
});
test('lost permission reply is reconciled and removed once; it never repeats a grant',async()=>{
 const f=fixture(),add=f.d.addPermission;f.d.addPermission=async id=>{await add(id);throw Error('unknown grant response');};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/unknown grant response/);
 assert.deepEqual(mutations(f),['add','remove']);assert.equal(f.state.policy,null);
 assert.ok(f.events.some(e=>e.stage==='routing_and_permission_restored'));
});
test('lost switch reply returns through a distinct observed deployment without replaying the failed switch',async()=>{
 const f=fixture(),switchUri=f.d.switchUri;f.d.switchUri=async uri=>{await switchUri(uri);if(uri===R.retainedArn)throw Error('unknown switch response');};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/unknown switch response/);
 assert.deepEqual(mutations(f),['add','switch:'+R.retainedArn,'switch:'+R.latestArn,'remove']);
 assert.equal(f.state.integration.IntegrationUri,R.latestArn);assert.equal(f.state.policy,null);
});
test('failed retained requests or deployment observation restores routing but never passes',async()=>{
 for(const point of ['consumer','deployment']){
 const f=fixture(),consume=f.d.consumerPhase,wait=f.d.waitDeployment;
 f.d.consumerPhase=async phase=>{if(point==='consumer'&&phase==='retained')throw Error('case failed');return consume(phase);};
 let waits=0;f.d.waitDeployment=async(...args)=>{if(point==='deployment'&&++waits===1)throw Error('deployment observation failed');return wait(...args);};
 await assert.rejects(rehearseCareRecovery(f.d,sid));assert.equal(f.state.integration.IntegrationUri,R.latestArn);assert.equal(f.state.policy,null);
 assert.equal(mutations(f).filter(c=>c==='switch:'+R.retainedArn).length,1);
 assert.equal(mutations(f).filter(c=>c==='switch:'+R.latestArn).length,1);}
});
test('partial, duplicate, wrong-status or forged-phase observations cannot pass',async()=>{
 for(const mutate of [v=>v.pop(),v=>v[1]=v[0],v=>v[0].verified=false,v=>v[0].status=403,v=>v[0].requestId='short',
 v=>v[0].bodySha256='unknown',v=>v[0].persona='other']){
 const f=fixture(),consume=f.d.consumerPhase;f.d.consumerPhase=async phase=>{const v=await consume(phase);mutate(v);return v;};
 await assert.rejects(rehearseCareRecovery(f.d,sid));assert.deepEqual(mutations(f),[]);}
 const f=fixture(),consume=f.d.consumerPhase;let baseline;
 f.d.consumerPhase=async phase=>{const v=await consume(phase);if(phase==='baseline')baseline=v;return phase==='returned'?baseline:v;};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/repeated_phase_request/);assert.equal(f.state.policy,null);
});
test('version metric refusal and changed postflight rows fail after confirmed restoration',async()=>{
 for(const point of ['metric','database']){
 const f=fixture();if(point==='metric')f.d.waitMetric=async()=>({Label:'Invocations',Datapoints:[]});
 else{let reads=0;f.d.inspect=async()=>{const p=preflight();if(++reads===2)p.database.rows++;return p;};}
 await assert.rejects(rehearseCareRecovery(f.d,sid));assert.equal(f.state.policy,null);assert.equal(f.state.integration.IntegrationUri,R.latestArn);
 assert.ok(f.events.some(e=>e.stage==='routing_and_permission_restored'));}
});
test('unrelated routing or policy drift is never overwritten to manufacture restoration',async()=>{
 for(const kind of ['uri','policy']){
 const f=fixture(),consume=f.d.consumerPhase;f.d.consumerPhase=async phase=>{const v=await consume(phase);if(phase==='retained'){
 if(kind==='uri')f.state.integration.IntegrationUri='unrelated';else f.state.latestPolicySha256='c'.repeat(64);throw Error('drift');}return v;};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/restoration_unconfirmed/);
 assert.deepEqual(mutations(f),['add','switch:'+R.retainedArn]);assert.notEqual(f.state.policy,null);}
});
test('permission removal denial cannot certify cleanup, and no blind repeated removal occurs',async()=>{
 const f=fixture();f.d.removePermission=async()=>{f.calls.push('remove-denied');throw Error('denied');};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/restoration_unconfirmed/);
 assert.equal(f.calls.filter(c=>c==='remove-denied').length,1);assert.notEqual(f.state.policy,null);
 assert.equal(f.events.some(e=>e.stage==='routing_and_permission_restored'),false);
});
test('same or later unobserved deployment refuses even when URI is original',async()=>{
 const f=fixture(),consume=f.d.consumerPhase;f.d.consumerPhase=async phase=>{const v=await consume(phase);
 if(phase==='returned')f.state.stage=stage('unobserved');return v;};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/restoration_unconfirmed/);assert.notEqual(f.state.policy,null);
});
test('durable event failure before grant performs no mutation; after switch still compensates',async()=>{
 for(const point of ['permission_admitted','retained_cases_verified']){
 const f=fixture(),record=f.d.record;f.d.record=async event=>{if(event.stage===point)throw Error('journal failed');return record(event);};
 await assert.rejects(rehearseCareRecovery(f.d,sid),/journal failed/);
 if(point==='permission_admitted')assert.deepEqual(mutations(f),[]);
 else{assert.equal(f.state.policy,null);assert.equal(f.state.integration.IntegrationUri,R.latestArn);}}
});
test('actual runner has no identity, execution-role, code, SQL upgrade, paid build or activation mutation',()=>{
 const script=readFileSync(new URL('./rehearse-synthetic-care-routing.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(script,/'upgrade'|'update-function-code'|'update-function-configuration'|'put-role-policy'|'execute-change-set'|AdminCreateUser|AdminSetUserPassword|SignUpCommand|PhiAllowed=true/);
 assert.match(script,/sourceRebuiltNow:false/);assert.match(script,/maxAttempts:1/);
 assert.match(script,/Name=Resource,Value=/);assert.doesNotMatch(script,/Name=ExecutedVersion/);
 assert.match(script,/if\(!admitted\|\|restored\)/);assert.match(script,/flag:'wx'/);
 assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
});
