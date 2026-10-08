import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {sha256} from './synthetic-care-release.mjs';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCareIntentDeployment,verifyCareIntentRecovery,releaseCareIntent} from './care-intent-release.mjs';
import {careIntentContinuationFixture} from './test-fixtures/care-intent-continuation.mjs';
const start=1700000000000,clone=structuredClone;
// Shared credential-free witness; the existing mutation assertions stay intact.
const fixture=careIntentContinuationFixture;
const deploy=f=>verifyCareIntentDeployment(f.supplied.deployment,f.supplied.candidate,f.supplied.current,f.supplied.artifact,
 f.supplied.preparation,f.d.started,f.d.now());
test('deployment readback requires raw projections, exact ZIP and preserved authority/configuration',()=>{
 assert.equal(deploy(fixture()).zipSha256.length,64);
 for(const mutation of [s=>s.deployment.codeBytes=Buffer.from('wrong'),s=>s.deployment.after.fn.CodeSize++,s=>s.deployment.after.fn.CodeSha256='wrong',
  s=>s.deployment.after.fn.RevisionId=s.deployment.before.live.fn.RevisionId,s=>s.deployment.after.fn.Environment.Variables.PHI_ALLOWED='true',
  s=>s.deployment.after.fn.Role='wrong',s=>s.deployment.after.fn.Layers=[{Arn:'wrong'}],s=>s.deployment.after.fn.VpcConfig={VpcId:'wrong'},
  s=>s.deployment.after.template.Resources.IdentityApiFunction.Properties.Timeout=30,s=>s.deployment.after.integration.CredentialsArn='wrong',
  s=>s.deployment.after.integration.IntegrationUri=R.retainedArn,s=>s.deployment.after.stage.DefaultRouteSettings.ThrottlingRateLimit=100,
  s=>s.deployment.after.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',s=>s.deployment.after.changeSet.ExecutionStatus='AVAILABLE',
  s=>s.deployment.after.stack.Stacks[0].Parameters[0].ParameterValue='wrong',s=>s.deployment.after.resources.StackResources[0].PhysicalResourceId='wrong',
  s=>s.deployment.after.control.roleSha256='c'.repeat(64),s=>s.deployment.after.control.policySha256='c'.repeat(64),
  s=>s.deployment.before.summary.Changes.push(clone(s.deployment.before.summary.Changes[1])),s=>s.deployment.before.detailed.NextToken='unread',
  s=>s.artifact.versionId='wrong',s=>s.deployment.observedAt=new Date(start-1).toISOString(),
  s=>s.deployment.current.desktop.commit='f'.repeat(40),s=>s.deployment.after.control.integrationsSha256='c'.repeat(64),
  s=>s.deployment.after.transport.routesSha256='c'.repeat(64),s=>s.deployment.after.transport.latestPolicySha256='c'.repeat(64),
  s=>s.deployment.after.transport.policy={},s=>s.deployment.after.transport.revisionId='wrong']){
  const f=fixture();mutation(f.supplied);assert.throws(()=>deploy(f));}
});
test('compatible recovery requires all 95 fresh Gateway observations and exact retained code/config',()=>{
 const f=fixture();assert.equal(verifyCareIntentRecovery(f.supplied.recovery,deploy(f),f.supplied.candidate,
  f.supplied.preparation.database,f.d.started,f.d.now()).policy,null);
 for(const mutation of [r=>r.retained.configuration.Version='1',r=>r.retained.configuration.FunctionArn=R.retainedArn,
  r=>r.retained.configuration.CodeSha256='wrong',r=>r.retained.configuration.Environment.Variables.PHI_ALLOWED='true',
  r=>r.retained.codeBytes=Buffer.from('wrong'),r=>r.observations.baseline.pop(),r=>r.observations.retained.pop(),
  r=>r.observations.returned[0].requestId=r.observations.baseline[0].requestId,
  r=>r.observations.returned.find(x=>x.case==='existing_cancelled_receipt').bodySha256='c'.repeat(64),
  r=>r.metricWitness.response.Datapoints=[],r=>r.metricWitness.minimum=0,r=>r.metricWitness.qualifier='1',
  r=>r.metricWitness.functionName='other',r=>r.databaseAfter.rowCount++,r=>r.transportWitness.restored.routesSha256='c'.repeat(64),
  r=>r.transportWitness.restored.revisionId='wrong',r=>r.transportWitness.restored.policy={},r=>r.transportWitness.retainedDeployment='returned',
  r=>r.preSchemaDenials.pop(),r=>r.preSchemaDenials[0].status=200,r=>r.preSchemaDenials[0].error='permission_denied',
  r=>r.preSchemaDenials[0].requestId=r.observations.baseline[0].requestId,r=>r.schemaChanged=true,r=>r.hostedAcceptance=true,
  r=>r.phiAllowed=true,r=>r.completedAt=new Date(start-1).toISOString()]){
  const x=fixture();mutation(x.supplied.recovery);assert.throws(()=>verifyCareIntentRecovery(x.supplied.recovery,deploy(x),
   x.supplied.candidate,x.supplied.preparation.database,x.d.started,x.d.now()));}
});
test('integrated continuation checks recovery before rollback, admission, commit and independent readback',async()=>{
 const f=fixture(),r=await releaseCareIntent(f.supplied,f.d);
 assert.equal(r.schemaChanged,true);assert.equal(r.preservationVerified,true);assert.equal(r.after.alreadyApplied,true);assert.equal(r.commitResponseLost,false);
 for(const k of ['canonicalRegistered','preparedErasedJourneyVerified','lostReplyJourneyVerified','secondDeviceJourneyVerified','fullJourneyAcceptance',
  'physicalDeviceAcceptance','qualificationEvidence','activationEvidence','phiAllowed','paidMobileBuildStarted'])assert.equal(r[k],false);
 assert.deepEqual(f.calls.filter(x=>x!=='current'),['transport','inspect','intent_rollback_admitted','rehearse','transport',
  'intent_schema_commit_admitted','upgrade','inspect','transport','intent_schema_independent_readback']);
});
test('lost COMMIT reply inspects once without replay or manufactured commit receipt',async()=>{
 const f=fixture(),schema=f.d.schema;
 f.d.schema=async c=>{const r=await schema(c);if(c==='upgrade')throw Object.assign(Error('transport'),{category:'upgrade_failed',commitOutcomeUnknown:true});return r;};
 const r=await releaseCareIntent(f.supplied,f.d);assert.equal(r.commitResponseLost,true);
 assert.equal(r.committed.status,'reconciled_without_commit_receipt');assert.equal(Object.hasOwn(r.committed,'applied'),false);
 assert.equal(f.calls.filter(c=>c==='upgrade').length,1);assert.equal(f.calls.filter(c=>c==='inspect').length,3);
 for(const cause of [Error('lost'),Object.assign(Error('reject'),{category:'boundary_refused',commitOutcomeUnknown:true})]){
  const x=fixture(),run=x.d.schema;x.d.schema=async c=>{if(c==='upgrade')throw cause;return run(c);};
  await assert.rejects(releaseCareIntent(x.supplied,x.d));assert.equal(x.calls.includes('intent_schema_independent_readback'),false);}
});
test('invalid receipts, changed preserved data, failed rollback or unknown admission never complete',async()=>{
 for(const command of ['inspect','rehearse','upgrade','postinspect'])for(const patch of [
  {dataSha256:'f'.repeat(64)},{schemaSha256:'f'.repeat(64)},{rowCount:23986},{dataPreserved:false},{schemaPreserved:false},
  {referenceLedgerSha256:'f'.repeat(64)},{phiAllowed:true},{operatorSource:{sourceCommit:'f'.repeat(40),clean:true}},
  {canonicalRegistered:true},{hostedAcceptance:true},{tableCount:999}]){
  const f=fixture(),schema=f.d.schema;let reads=0;
  f.d.schema=async c=>{const r=await schema(c),mode=c==='inspect'&&++reads>1?'postinspect':c;return mode===command?{...r,...patch}:r;};
  await assert.rejects(releaseCareIntent(f.supplied,f.d));if(['inspect','rehearse'].includes(command))assert.equal(f.calls.includes('upgrade'),false);
  assert.equal(f.calls.includes('intent_schema_independent_readback'),false);}
 const f=fixture();f.d.admit=async()=>{throw Error('journal unavailable');};
 await assert.rejects(releaseCareIntent(f.supplied,f.d));assert.equal(f.calls.includes('upgrade'),false);
});
test('ports cannot rewrite snapshotted witnesses or age out recovery to gain schema admission',async()=>{
 for(const mutation of [f=>{f.supplied.current.desktop.commit='f'.repeat(40);},f=>{f.transport.revisionId='drift';
  f.supplied.recovery.transportWitness.restored.revisionId='drift';},f=>f.advance(300001)]){
  const f=fixture(),schema=f.d.schema;f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse')mutation(f);return r;};
  await assert.rejects(releaseCareIntent(f.supplied,f.d));assert.equal(f.calls.includes('upgrade'),false);}
});
test('embedded port has no standalone CLI/report/target override; historical upgrade refusal remains',()=>{
 const code=readFileSync(new URL('../src/server/clinical-core/care-erasure-intent-release-database.ts',import.meta.url),'utf8');
 assert.match(code,/maxAttempts:1/);assert.match(code,/transport.failure\(\)\?\.startsWith\('commit_'\)/);
 assert.match(code,/build.clean!==true/);assert.match(code,/JSON.stringify\(observe\(\)\)!==JSON.stringify\(configuration\)/);
 assert.doesNotMatch(code,/process\.env|process\.argv|readFileSync|--approve|--report/);
 assert.match(readFileSync(new URL('../src/server/clinical-core/care-erasure-intent-command.ts',import.meta.url),'utf8'),
  /command==='upgrade'\)refuse\('api_recovery_required'\)/);
 execFileSync(process.execPath,['scripts/build-care-erasure-intent-release.mjs'],{encoding:'utf8',timeout:30000});
 const m=JSON.parse(readFileSync('dist/aws-clinical-core/care-erasure-intent-release/artifact-manifest.json','utf8'));
 const bytes=readFileSync('dist/aws-clinical-core/care-erasure-intent-release/index.cjs');assert.equal(m.sha256,sha256(bytes));
 assert.equal(m.standaloneUpgradeAvailable,false);assert.equal(m.migrationPerformed,false);
 assert.equal(m.releaseMapping.liveBeforeCount,47);assert.equal(m.releaseMapping.liveAfterCount,48);
 assert.match(bytes.toString(),/4be2ca72b0486bec171f16c5299c898d70bfbdbfd3143c4bb216fccc329299ec/);
});
