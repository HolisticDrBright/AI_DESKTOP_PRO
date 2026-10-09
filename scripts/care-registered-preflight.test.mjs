import {careRegisteredDatabaseFixture} from './test-fixtures/care-registered-database.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P,sha256} from './synthetic-care-release.mjs';
import {CARE_REGISTERED as C,createCareRegisteredCandidate} from './synthetic-care-registered-release.mjs';
import {canonicalCareRegistrationDescriptor} from './care-canonical-migrations.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {careControlSource,careControlObservation} from './test-fixtures/care-control.mjs';
import {CARE_REGISTERED_PREDECESSOR,careRegisteredPredecessorTemplate,verifyCareRegisteredFunction,
 verifyCareRegisteredPredecessorControl,verifyCareRegisteredDatabase,runCareRegisteredPreflight} from './care-registered-preflight.mjs';
import {careRegisteredPreflightArguments,registeredPreflightFailureCode,runCareRegisteredInspectorChild,
 careRegisteredInspectorDiagnostic} from './prepare-synthetic-care-registered-release.mjs';
const clone=structuredClone;
function fixture(){
 const sourceText=readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
 const current={desktop:{commit:'a'.repeat(40),clean:true,files:20,sha256:'b'.repeat(64)},
  mobile:{source:{commit:'c'.repeat(40),clean:true,files:21,sha256:'d'.repeat(64)},built:false,deviceVerified:false,
   ...Object.fromEntries(['contractSha256','requestJournalSha256','transportSha256','easSha256','recoveryContractSha256','recoveryUiSha256'].map(k=>[k,'e'.repeat(64)]))},
  migrations:canonicalCareRegistrationDescriptor(),templateSha256:sha256(sourceText)};
 const candidate=createCareRegisteredCandidate(current,Buffer.from('exports.handler=async()=>({statusCode:403});\n')),
  source=clone(careControlSource),raw=careControlObservation();
 raw.template=careRegisteredPredecessorTemplate(source);
 raw.foundation.Stacks[0].StackName=P.foundation;raw.stack.Stacks[0].StackName=P.stack;
 raw.stack.Stacks[0].StackId=CARE_REGISTERED_PREDECESSOR.stackId;
 raw.stack.Stacks[0].Parameters.find(p=>p.ParameterKey==='LambdaCodeKey').ParameterValue=candidate.release.predecessor.key;
 raw.fn.CodeSha256=Buffer.from(C.predecessorZip,'hex').toString('base64');raw.fn.CodeSize=C.predecessorBytes;
 raw.routes.Items.forEach((r,i)=>r.RouteId='r'+i);
 const old=raw.resources.StackResources;
 raw.resources.StackResources=Object.entries(raw.template.Resources).map(([LogicalResourceId,r])=>{
  let PhysicalResourceId=old.find(x=>x.LogicalResourceId===LogicalResourceId)?.PhysicalResourceId;
  if(r.Type==='AWS::ApiGatewayV2::Route')PhysicalResourceId=raw.routes.Items.find(x=>x.RouteKey===r.Properties.RouteKey).RouteId;
  if(LogicalResourceId==='IdentityApiFunction')PhysicalResourceId=P.functionName;
  if(LogicalResourceId==='IdentityApiIntegration')PhysicalResourceId=R.integrationId;
  if(LogicalResourceId==='ConsumerJwtAuthorizer')PhysicalResourceId='consumer';
  if(LogicalResourceId==='WorkforceJwtAuthorizer')PhysicalResourceId='workforce';
  if(LogicalResourceId==='IdentityApiInvokePermission')PhysicalResourceId=JSON.parse(raw.latestPolicy.Policy).Statement[0].Sid;
  return {LogicalResourceId,ResourceType:r.Type,PhysicalResourceId:PhysicalResourceId??'fictional-'+LogicalResourceId,ResourceStatus:'UPDATE_COMPLETE'};
 });
 for(let n=raw.routes.Items.length;n<112;n++)raw.routes.Items.push({RouteId:'foreign'+n,RouteKey:'GET /fictional-other/'+n,Target:'integrations/other'});
 // Published receipt shape reused ONLY as fictional test input. The actual
 // runner calls the compiled database observer and never loads this file.
 const db=careRegisteredDatabaseFixture(current,Date.parse('2026-10-08T04:00:00Z'));
 db.operatorSource={sourceCommit:current.desktop.commit,clean:true};
 let clock=Date.parse('2026-10-08T04:00:00Z'),time=()=>clock;
 db.observedAt=new Date(clock).toISOString();const calls=[];
 const local={byteVerified:true,sourceRebuilt:true,zipSha256:candidate.manifest.zipSha256,desktopCommit:current.desktop.commit,
  mobileCommit:current.mobile.source.commit,liveTargetObserved:false,deployed:false,phiAllowed:false};
 const caller={Account:P.account,Arn:`arn:aws:sts::${P.account}:assumed-role/OrganizationAccountAccessRole/fictional`,UserId:'fictional'};
 const downloads={managedSha256:C.predecessorZip,managedBytes:C.predecessorBytes,storedSha256:C.predecessorZip,storedBytes:C.predecessorBytes,
  version:C.predecessorVersion,exactBytesVerified:true};
 const retained={configuration:{...clone(raw.fn),FunctionArn:R.latestArn+':2',Version:'2'},sha256:C.predecessorZip,bytes:C.predecessorBytes,policy:null};
 const port={sourceText,now:time,rebuild:async()=>{calls.push('rebuild');return clone(local);},
  current:async()=>{calls.push('current');return clone(current);},identity:async()=>{calls.push('identity');return clone(caller);},
  database:async()=>{calls.push('database');return clone(db);},control:async()=>{calls.push('control');return clone(raw);},
  downloads:async()=>{calls.push('downloads');return clone(downloads);},retained:async()=>{calls.push('retained');return clone(retained);}};
 return {source,current,candidate,raw,db,local,caller,downloads,retained,port,calls,now:time,advance:ms=>{clock+=ms;}};
}
const run=f=>runCareRegisteredPreflight(f.candidate,f.current,f.source,f.port);

test('actual inspector child keeps the static failed phase and transport diagnostic instead of discarding the cause',()=>{
 const code='upgrade_failed:begin_database_resuming';
 assert.throws(()=>runCareRegisteredInspectorChild(process.cwd(),['-e',
  `process.stderr.write(${JSON.stringify(code+'\n')});process.exitCode=1;`]),
  {message:'synthetic_care_registered_release_refused:preflight_inspector_inspect_failed_upgrade_failed_begin_database_resuming'});
});

test('finite inspector vocabulary preserves only static codes and rejects arbitrary stderr and incomplete process outcomes',()=>{
 const categories=['care_canonical_registration_boundary_refused','care_canonical_registration_observation_changed',
  'care_canonical_registration_failed','artifact_refused','history_refused','boundary_refused','inventory_refused',
  'verification_failed','upgrade_failed'];
 const reasons=['database_resuming','database_unavailable','access_denied','token_expired','credentials_unavailable','timeout',
  'aborted','transaction_missing','statement_timeout','service_unavailable','transport_type_error','connection_reset','unknown'];
 for(const category of categories){
  assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:category+'\r\n'},'inspect'),category);
  for(const phase of ['begin','statement','commit','rollback','unknown'])for(const reason of reasons){
   const text=category+':'+phase+'_'+reason;
   assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:Buffer.from(text+'\n')},'inspect'),text.replace(':','_'));
  }
 }
 for(const stderr of ['upgrade_failed:begin_credential_secret','care_canonical_registration_sk_secret',
  'upgrade_failed:begin_database_resuming\nSQL=secret','upgrade_failed:begin_database_resuming:secret',
  'upgrade_failed\n\n',' upgrade_failed','upgrade_failed\0','upgrade_failed:sql_database_resuming','x'.repeat(257),
  'Bearer abc https://secret?token=abc patient=private',undefined,{},Buffer.from([255])]){
  assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr},'inspect'),'unknown');
 }
 for(const status of [0,null,undefined,256,-1,1.5])assert.equal(careRegisteredInspectorDiagnostic({status,stderr:'upgrade_failed'},'inspect'),'unknown');
 assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:'upgrade_failed'},'build'),'unknown');
 assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:'upgrade_failed',code:'ETIMEDOUT'},'inspect'),'timeout');
 assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:'upgrade_failed',code:'ENOBUFS'},'inspect'),'output_limit');
 assert.equal(careRegisteredInspectorDiagnostic({status:1,stderr:'upgrade_failed',signal:'SIGTERM'},'inspect'),'terminated');
 assert.throws(()=>careRegisteredInspectorDiagnostic({},'deploy'));
});

test('actual child errors are sanitized, timeout is terminal and success output remains an observation not authorization',()=>{
 const run=(script,phase='inspect',timeout=180000)=>runCareRegisteredInspectorChild(process.cwd(),['-e',script],phase,timeout);
 for(const phase of ['build','inspect']){
  assert.throws(()=>run("process.stderr.write('Bearer secret; patient=private');process.exitCode=1;",phase),
   {message:'synthetic_care_registered_release_refused:preflight_inspector_'+phase+'_failed_unknown'});
 }
 assert.throws(()=>run("process.stderr.write('upgrade_failed\\n');process.exitCode=1;",'build'),
  {message:'synthetic_care_registered_release_refused:preflight_inspector_build_failed_unknown'});
 assert.throws(()=>run('setInterval(()=>{},1000);','inspect',150),
  {message:'synthetic_care_registered_release_refused:preflight_inspector_inspect_failed_timeout'});
 assert.throws(()=>run('process.stdout.write("x".repeat(3*1024*1024));'),
  {message:'synthetic_care_registered_release_refused:preflight_inspector_inspect_failed_output_limit'});
 assert.equal(run('process.stdout.write(JSON.stringify({inspectionOnly:true}));'),JSON.stringify({inspectionOnly:true}));
 assert.throws(()=>runCareRegisteredInspectorChild(process.cwd(),[],'deploy'));
 assert.throws(()=>runCareRegisteredInspectorChild(process.cwd(),[],'inspect',180001));
});

test('predecessor control compares the current exact template, complete resource identity and all JWT routes without old-code normalization',()=>{
 const f=fixture(),saved=clone(f.raw),r=verifyCareRegisteredPredecessorControl(f.raw,f.source);
 assert.equal(r.identityRouteCount,51);assert.equal(r.apiRouteCount,112);
 assert.equal(r.codeSha256,Buffer.from(C.predecessorZip,'hex').toString('base64'));assert.equal(r.phiAllowed,false);
 assert.deepEqual(f.raw,saved);
});
test('control refuses changed boundary, incomplete resources, code, configuration, IAM, routing, logging and invocation authority',()=>{
 const mutations=[o=>o.foundation.Stacks[0].StackName='other',o=>o.foundation.Stacks[0].Outputs.find(x=>x.OutputKey==='PhiAllowed').OutputValue='true',
  o=>o.stack.Stacks[0].StackId+='other',o=>o.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',
  o=>o.stack.Stacks[0].Parameters.push(clone(o.stack.Stacks[0].Parameters[0])),o=>o.template.Resources.IdentityApiFunction.Properties.Timeout=30,
  o=>o.resources.NextToken='more',o=>o.resources.StackResources.pop(),o=>o.resources.StackResources[0].ResourceStatus='DELETE_COMPLETE',
  o=>o.resources.StackResources.find(x=>x.LogicalResourceId==='IdentityApiFunction').PhysicalResourceId='other',
  o=>o.fn.CodeSize++,o=>o.fn.CodeSha256='wrong',o=>o.fn.Runtime='nodejs20.x',o=>o.fn.Timeout=30,
  o=>o.fn.Layers=[{Arn:'other'}],o=>o.fn.Environment.Variables.PHI_ALLOWED='true',o=>o.fn.Environment.Error={Message:'unavailable'},
  o=>o.fn.VpcConfig={SubnetIds:['other']},o=>o.fn.DeadLetterConfig={TargetArn:'other'},o=>o.fn.DurableConfig={},
  o=>o.fn.RuntimeVersionConfig={RuntimeVersionArn:'other'},o=>o.fn.RuntimeVersionConfig={Error:{Message:'failed'}},
  o=>o.fn.Role='other',o=>o.attached.AttachedPolicies.push({PolicyArn:'AdministratorAccess'}),o=>o.inline.IsTruncated=true,
  o=>o.policies[0].PolicyDocument.Statement[0].Resource='*',o=>o.logGroups.nextToken='more',o=>o.logGroups.logGroups[0].kmsKeyId='other',
  o=>o.routes.NextToken='more',o=>o.routes.Items.pop(),o=>o.routes.Items[0].RouteId=o.routes.Items[1].RouteId,
  o=>o.routes.Items[0].AuthorizationType='NONE',o=>o.routes.Items[0].RouteId='wrong',o=>o.routes.Items[0].ApiKeyRequired=true,
  o=>o.authorizers.NextToken='more',o=>o.authorizers.Items[0].JwtConfiguration.Audience.push('other'),
  o=>o.integrations.Items[0].IntegrationUri=R.latestArn+':2',o=>o.integrations.Items[0].TimeoutInMillis=29000,
  o=>o.stage.AutoDeploy=false,o=>o.stage.DefaultRouteSettings.ThrottlingRateLimit=100,
  o=>o.latestPolicy.Policy='{}',o=>o.resources.StackResources.find(x=>x.LogicalResourceId==='IdentityApiInvokePermission').PhysicalResourceId='other'];
 for(const change of mutations){const f=fixture();change(f.raw);assert.throws(()=>verifyCareRegisteredPredecessorControl(f.raw,f.source),undefined,change.toString());}
});
test('retained function is exact intent-compatible version2, not the older version1 or an optional config expansion',()=>{
 const f=fixture();verifyCareRegisteredFunction(f.retained.configuration,true);
 for(const change of [r=>r.Version='1',r=>r.FunctionArn=R.retainedArn,r=>r.State='Pending',r=>r.CodeSize--,
  r=>r.MemorySize=512,r=>r.FileSystemConfigs=[{}],r=>r.SnapStart={ApplyOn:'PublishedVersions',OptimizationStatus:'On'}]){
  const x=clone(f.retained.configuration);change(x);assert.throws(()=>verifyCareRegisteredFunction(x,true));
 }
});
test('database observation binds current clean inspector, fresh registered ledger and complete preservation rather than historic approval',()=>{
 const f=fixture();verifyCareRegisteredDatabase(f.db,f.current,f.now(),f.now());
 for(const change of [r=>delete r.operatorSource,r=>r.operatorSource.clean=false,r=>r.operatorSource.sourceCommit='f'.repeat(40),
  r=>r.observedAt='invalid',r=>r.observedAt='2026-10-08T03:59:59Z',r=>r.awsAccountId='173535830222',r=>r.canonicalRegistered=false,
  r=>r.liveMigrationCount=47,r=>r.sourceLedgerSha256='f'.repeat(64),r=>r.schemaReplayPerformed=true,r=>r.releaseAccepted=true,
  r=>r.repeatedReadbackVerified=false,r=>r.catalogInspection.canonicalRegistered=true,
  r=>r.catalogInspection.referenceMigrationCount=1,r=>r.catalogInspection.rowCount++,r=>r.catalogInspection.dataSha256='f'.repeat(64),
  r=>r.catalogInspection.preservedSchemaSha256='f'.repeat(64),r=>r.phiAllowed=true]){
  const x=clone(f.db);change(x);assert.throws(()=>verifyCareRegisteredDatabase(x,f.current,f.now(),f.now()),undefined,change.toString());
 }
});
test('historical reference2 report cannot become current by relabeling its contract or ledger identity',()=>{
 const f=fixture(),old=JSON.parse(readFileSync(new URL('../docs/evidence/2026-10-08-care-intent-canonical-registration.json',import.meta.url),'utf8')).inspection;
 old.operatorSource={sourceCommit:f.current.desktop.commit,clean:true};old.observedAt=new Date(f.now()).toISOString();
 assert.throws(()=>verifyCareRegisteredDatabase(old,f.current,f.now(),f.now()),/database_boundary/);
 for(const change of [r=>r.contract=old.contract,r=>r.referenceMigrationCount=2,
  r=>r.referenceLedgerSha256=old.referenceLedgerSha256,r=>r.catalogInspection=old.historicalInspection,
  r=>r.historicalInspection=old.historicalInspection,r=>r.catalogInspection.extraAcceptance=true,
  r=>r.catalogInspection.historicalLedgerPreserved=false,r=>r.catalogInspection.candidateSqlSha256='a'.repeat(64)]){
  const r=clone(f.db);change(r);assert.throws(()=>verifyCareRegisteredDatabase(r,f.current,f.now(),f.now()));
 }
});
test('current registration refuses every extra outer authority claim or missing contract field',()=>{
 const f=fixture();verifyCareRegisteredDatabase(f.db,f.current,f.now(),f.now());
 for(const key of ['hostedAcceptance','productionApproved','matchedReleaseAccepted','deployAuthorized','schemaChanged','phiActivation','unknown']){
  for(const value of [true,false,null]){
   const r=clone(f.db);r[key]=value;
   assert.throws(()=>verifyCareRegisteredDatabase(r,f.current,f.now(),f.now()),/database_boundary/,key+':'+value);
  }
 }
 for(const key of Object.keys(f.db)){
  const r=clone(f.db);delete r[key];
  assert.throws(()=>verifyCareRegisteredDatabase(r,f.current,f.now(),f.now()),undefined,key);
 }
});

test('complete fictional observation port requires independent rebuild and two live reads but certifies no deployment or acceptance',async()=>{
 const f=fixture(),result=await run(f);
 assert.equal(result.liveTargetObserved,true);assert.equal(result.repeatedReadbackVerified,true);
 for(const k of ['deployAuthorized','awsMutationPerformed','schemaReplayPerformed','recoveryRehearsed','erasureAccepted','hostedAcceptance',
  'releaseAccepted','physicalDeviceAcceptance','phiAllowed','paidMobileBuildStarted'])assert.equal(result[k],false);
 assert.equal(f.calls.filter(x=>x==='database').length,2);assert.equal(f.calls.filter(x=>x==='control').length,2);
 assert.equal(f.calls.filter(x=>x==='retained').length,2);assert.equal(f.calls.filter(x=>x==='identity').length,2);
 assert.equal(f.calls[0],'rebuild');assert.deepEqual(result.current,f.current);
});
test('byte-only reconstruction, wrong role/source or failed observations cannot reach a successful preflight',async()=>{
 for(const mutate of [f=>f.local.sourceRebuilt=false,f=>f.local.zipSha256='f'.repeat(64),f=>f.local.desktopCommit='f'.repeat(40),
  f=>f.local.liveTargetObserved=true,f=>f.caller.Arn=`arn:aws:iam::${P.account}:root`,f=>f.caller.Account='173535830222',
  f=>{f.port.sourceText+=' ';},f=>{f.port.database=async()=>{throw Error('unavailable');};}]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
 const f=fixture();f.local.sourceRebuilt=false;await assert.rejects(run(f));assert.deepEqual(f.calls,['rebuild']);
});
test('each predecessor stream and exact version, retained bytes and absent retained permission are mandatory',async()=>{
 for(const mutate of [f=>f.downloads.managedSha256='f'.repeat(64),f=>f.downloads.managedBytes--,
  f=>f.downloads.storedSha256='f'.repeat(64),f=>f.downloads.storedBytes++,f=>f.downloads.version='other',
  f=>f.downloads.exactBytesVerified=false,f=>f.retained.policy={},f=>f.retained.bytes++,f=>f.retained.sha256='f'.repeat(64)]){
  const f=fixture();mutate(f);await assert.rejects(run(f));
 }
});
test('source, principal, controls, retained configuration and database drift after first observations refuse without a mutation port',async()=>{
 for(const kind of ['source','principal','control','retained','database']){
  const f=fixture();let n=0;
  const key={source:'current',principal:'identity',control:'control',retained:'retained',database:'database'}[kind],old=f.port[key];
  f.port[key]=async()=>{const r=await old();if(++n===2){
   if(kind==='source')r.desktop.sha256='f'.repeat(64);
   if(kind==='principal')r.Arn+='changed';
   if(kind==='control')r.fn.RevisionId='changed';
   if(kind==='retained')r.configuration.RevisionId='changed';
   if(kind==='database')r.catalogInspection.referenceMigrationCount=1;
  }return r;};await assert.rejects(run(f),undefined,kind);
 }
 const f=fixture(),old=f.port.database;f.port.database=async()=>{const r=await old();f.advance(300001);return r;};await assert.rejects(run(f));
});
test('fixed read-only parser has no approval, report, profile, target, upload, execute or paid-build override',()=>{
 const accepted=careRegisteredPreflightArguments(['--v2-root','.','--artifact','.','--inspect-fictional-current-release-only']);assert(accepted.directory);
 for(const a of [[],['--v2-root','.','--artifact','.'],['--v2-root','.','--artifact','.','--deploy'],
  ['--v2-root','.','--report','pass.json','--inspect-fictional-current-release-only'],
  ['--v2-root','.','--artifact','--phi=true','--inspect-fictional-current-release-only'],
  ['--v2-root','.','--artifact','.','--inspect-fictional-current-release-only','--profile','production']])assert.throws(()=>careRegisteredPreflightArguments(a));
 const secrets='token sk-proj-secret https://provider?token=secret health=fictional';
 assert.equal(registeredPreflightFailureCode(Error(secrets)),'synthetic_care_registered_release_refused:preflight_failed');
 assert.equal(registeredPreflightFailureCode(Error('synthetic_care_registered_release_refused:preflight_database_changed')),
  'synthetic_care_registered_release_refused:preflight_database_changed');
});
