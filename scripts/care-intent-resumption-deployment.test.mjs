import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CARE_RECOVERY_ROUTE as R} from './care-recovery-routing.mjs';
import {verifyCareIntentExecutedDependencyViews,verifyCareIntentDependencyViews} from './prepare-synthetic-care-intent-code-change.mjs';
import {verifyExecutedCareCodeChangeSet,verifyCareCodeChangeSet} from './prepare-synthetic-care-code-change.mjs';
import {verifyCareIntentResumptionBindings,verifyCareIntentHistoricalDownload,verifyCareIntentResumedDeployment,
 careIntentHistoricalTemplate,careIntentResumptionInput} from './care-intent-resumption-deployment.mjs';
import {releaseResumedCareIntent} from './care-intent-release.mjs';
import {careIntentResumptionFixture} from './test-fixtures/care-intent-resumption.mjs';
const clone=structuredClone;
const verify=f=>verifyCareIntentResumedDeployment(f.supplied.deployment,f.supplied.candidate,f.application,f.operator,f.d.started,f.d.now());
function bindRecovery(f){
 const p=verify(f);f.supplied.recovery.transportWitness.restored=clone(p.transport);f.transport=p.transport;f.d.transport=async()=>clone(p.transport);
 return p;
}
test('executed projections are an explicit profile; the original available-only guard still refuses them',()=>{
 const f=careIntentResumptionFixture(),w=f.supplied.deployment,input=careIntentResumptionInput(w.source,f.supplied.candidate,w.artifact);
 const history={template:careIntentHistoricalTemplate(w.source),fn:w.predecessor.configuration,
  integration:w.raw.integrations.Items[0],resources:w.raw.resources};
 const before=clone(w);
 assert.equal(verifyCareIntentExecutedDependencyViews(w.summary,w.detailed,w.proposedTemplate,input,w.binding,history).executionCompleteObserved,true);
 assert.throws(()=>verifyCareIntentDependencyViews(w.summary,w.detailed,w.proposedTemplate,input,w.binding,history));
 const lambda={...w.summary,Changes:[w.summary.Changes[0]]};
 verifyExecutedCareCodeChangeSet(lambda,w.proposedTemplate,input,w.binding);
 assert.throws(()=>verifyCareCodeChangeSet(lambda,w.proposedTemplate,input,w.binding));
 assert.deepEqual(clone(w),before);
 for(const mutate of [v=>v.ExecutionStatus='AVAILABLE',v=>v.ExecutionStatus='EXECUTE_IN_PROGRESS',v=>v.NextToken='hidden',
  v=>v.Changes.push(clone(v.Changes[0])),v=>v.Parameters.push(clone(v.Parameters[0])),v=>v.ParentChangeSetId='other',
  v=>v.DeploymentConfig.DisableRollback=true,v=>v.Changes[1].ResourceChange.Details[0].CausingEntity='other']){
  const x=careIntentResumptionFixture();mutate(x.supplied.deployment.summary);assert.throws(()=>verify(x));
 }
});
test('application/operator separation permits no contract, migration, destination or unclean-source differences',()=>{
 const f=careIntentResumptionFixture();verifyCareIntentResumptionBindings(f.application,f.operator);
 for(const mutate of [o=>o.desktop.clean=false,o=>o.mobile.source.clean=false,o=>o.migrations.liveAfter='f'.repeat(64),
  o=>o.mobile.easSha256='f'.repeat(64),o=>o.mobile.contractSha256='f'.repeat(64),o=>o.mobile.requestJournalSha256='f'.repeat(64),
  o=>o.mobile.transportSha256='f'.repeat(64),o=>o.mobile.recoveryContractSha256='f'.repeat(64),o=>o.mobile.recoveryUiSha256='f'.repeat(64),
  o=>o.mobile.built=true,o=>o.mobile.deviceVerified=true,o=>o.templateSha256='f'.repeat(64)]){
  const x=careIntentResumptionFixture();mutate(x.operator);assert.throws(()=>verifyCareIntentResumptionBindings(x.application,x.operator));
 }
});
test('fresh deployment reconciliation pins actual bytes, source, executed projection, immutable history and authority',()=>{
 const f=careIntentResumptionFixture(),before=clone(f.supplied.deployment),p=verify(f);
 assert.equal(p.deploymentReconciled,true);assert.equal(p.immutablePredecessorUsedForRouting,false);
 assert.equal(p.operatorCurrent.desktop.commit,f.operator.desktop.commit);assert.deepEqual(clone(f.supplied.deployment),before);
 for(const mutate of [w=>w.observedAt='invalid',w=>w.sourceText+=' ',w=>w.codeBytes=Buffer.from('wrong'),
  w=>w.operatorCurrent.desktop.commit='9'.repeat(40),w=>w.applicationCurrent.mobile.source.commit='9'.repeat(40),
  w=>w.artifact.versionId='wrong',w=>w.artifact.exactVersionReadbackVerified=false,w=>w.artifact.encryption='AES256',
  w=>w.binding.name='care-intent-'+('f'.repeat(32)),w=>w.raw.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',
  w=>w.raw.fn.CodeSize++,w=>w.raw.fn.CodeSha256='wrong',w=>w.raw.fn.Role='wrong',w=>w.raw.fn.Runtime='nodejs20.x',
  w=>w.raw.fn.Layers=[{Arn:'other'}],w=>w.raw.fn.Environment.Variables.PHI_ALLOWED='true',
  w=>w.raw.resources.StackResources.pop(),w=>w.raw.resources.NextToken='hidden',w=>w.raw.resources.StackResources[0].ResourceType='other',
  w=>w.raw.routes.Items[0].AuthorizationType='NONE',w=>w.raw.authorizers.Items[0].JwtConfiguration.Audience.push('other'),
  w=>w.raw.attached.AttachedPolicies.push({PolicyArn:'AdministratorAccess'}),w=>w.raw.latestPolicy.Policy='{}',
  w=>w.raw.logGroups.logGroups[0].retentionInDays=0,w=>w.raw.foundation.Stacks[0].Outputs.find(o=>o.OutputKey==='PhiAllowed').OutputValue='true',
  w=>w.raw.integrations.Items[0].IntegrationUri=R.retainedArn,w=>w.retainedPolicy={},
  w=>w.predecessor.configuration.Version='$LATEST',w=>w.predecessor.configuration.FunctionArn=R.latestArn,
  w=>w.predecessor.download.exactBytesVerified=false,w=>w.predecessor.download.sha256='f'.repeat(64),
  w=>w.retained.configuration.Version='1',w=>w.retained.configuration.Description='other',w=>w.retained.codeBytes=Buffer.from('other')]){
  const x=careIntentResumptionFixture();mutate(x.supplied.deployment);assert.throws(()=>verify(x),mutate.toString());
 }
 for(const bytes of [undefined,new Uint8Array(1),Buffer.alloc(0),Buffer.from('wrong')])assert.throws(()=>verifyCareIntentHistoricalDownload(bytes));
});
test('resumed schema continuation preserves application identity but requires the current operator on every database result',async()=>{
 const f=careIntentResumptionFixture();bindRecovery(f);
 const r=await releaseResumedCareIntent(f.supplied,f.d);
 assert.equal(r.schemaChanged,true);assert.equal(r.current.desktop.commit,f.application.desktop.commit);
 assert.equal(r.operatorCurrent.desktop.commit,f.operator.desktop.commit);assert.equal(r.after.operatorSource.sourceCommit,f.operator.desktop.commit);
 assert.equal(f.calls.filter(c=>c==='upgrade').length,1);assert.equal(r.canonicalRegistered,false);assert.equal(r.phiAllowed,false);
 for(const command of ['inspect','rehearse','upgrade']){
  const x=careIntentResumptionFixture();bindRecovery(x);const schema=x.d.schema;
  x.d.schema=async c=>{const r=await schema(c);if(c===command)r.operatorSource.sourceCommit=x.application.desktop.commit;return r;};
  await assert.rejects(releaseResumedCareIntent(x.supplied,x.d));
  if(command!=='upgrade')assert.equal(x.calls.includes('upgrade'),false);
 }
});
test('resumed ports cannot mutate snapshots or change live source, data or transport to acquire an upgrade',async()=>{
 for(const mutate of [f=>{f.operator.desktop.sha256='3'.repeat(64);},f=>{f.transport.revisionId='changed';},f=>f.advance(300001)]){
  const f=careIntentResumptionFixture();bindRecovery(f);const schema=f.d.schema;
  f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse')mutate(f);return r;};
  await assert.rejects(releaseResumedCareIntent(f.supplied,f.d));assert.equal(f.calls.includes('upgrade'),false);
 }
 const f=careIntentResumptionFixture();bindRecovery(f);const schema=f.d.schema,original=f.application.desktop.commit;
 f.d.schema=async c=>{const r=await schema(c);if(c==='rehearse')f.supplied.current.desktop.commit='3'.repeat(40);return r;};
 const r=await releaseResumedCareIntent(f.supplied,f.d);assert.equal(r.current.desktop.commit,original);
});
test('resumed unknown commit reconciles once; forged receipt, known rejection or stale recovery never replay',async()=>{
 const f=careIntentResumptionFixture();bindRecovery(f);const schema=f.d.schema;
 f.d.schema=async c=>{const r=await schema(c);if(c==='upgrade')throw Object.assign(Error('lost'),{category:'upgrade_failed',commitOutcomeUnknown:true});return r;};
 const r=await releaseResumedCareIntent(f.supplied,f.d);assert.equal(r.commitResponseLost,true);
 assert.equal(f.calls.filter(c=>c==='upgrade').length,1);assert.equal(r.committed.status,'reconciled_without_commit_receipt');
 const x=careIntentResumptionFixture();bindRecovery(x);x.supplied.recovery.observations.retained.pop();
 await assert.rejects(releaseResumedCareIntent(x.supplied,x.d));assert.equal(x.calls.includes('rehearse'),false);
});
