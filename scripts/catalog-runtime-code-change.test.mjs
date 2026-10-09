import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {catalogRuntimeProposalFixture as fixture} from './test-fixtures/catalog-runtime-proposal.mjs';
import {catalogRuntimeCodeChangeInputs,parseRegisteredPropertyContext,
 verifyCatalogRuntimeProposalViews} from './catalog-runtime-code-change.mjs';
const inputs=f=>catalogRuntimeCodeChangeInputs(f.sourceText,f.candidate,f.current,f.preflight,f.artifact,f.now);
const verify=f=>verifyCatalogRuntimeProposalViews(f.summary,f.detailed,f.input.template,f.input,f.binding,f.raw,
 f.sourceText,f.preflight,f.current,f.candidate,f.artifact,f.now);
const context=f=>{f.detailed.Changes[0].ResourceChange.BeforeContext=JSON.stringify(f.before);
 f.detailed.Changes[0].ResourceChange.AfterContext=JSON.stringify(f.after);};
test('catalog-runtime proposal binds exact current history, source, artifact and both exhaustive views without admitting execution',()=>{
 const f=fixture(),prior=JSON.stringify(f),result=verify(f);
 assert.equal(result.summaryResourceCount,2);assert.equal(result.propertyValuesResourceCount,1);
 assert.equal(result.integrationDependencyClassified,true);assert.equal(result.integrationNoOpProven,false);
 for(const k of ['executionAdmissible','deployed','schemaChanged','hostedAcceptance','releaseAccepted','phiAllowed','paidMobileBuildStarted'])assert.equal(result[k],false);
 assert.equal(JSON.stringify(f),prior);
 assert.deepEqual(f.input.template.Resources.IdentityApiFunction.Properties.Code,
  {...f.raw.template.Resources.IdentityApiFunction.Properties.Code,S3ObjectVersion:f.artifact.versionId});
 assert.equal(f.input.parameters.filter(p=>p.UsePreviousValue===true).length,10);
});
test('input refuses stale preflight, wrong source, unknown artifact flags, version, key, bytes and unverifiable upload',()=>{
 for(const mutate of [f=>f.now+=120001,f=>f.sourceText+=' ',f=>f.preflight.control.templateSha256='0'.repeat(64),
  f=>f.artifact.key+='other',f=>f.artifact.bucket='other',f=>f.artifact.sha256='0'.repeat(64),f=>f.artifact.bytes++,
  f=>f.artifact.versionId='null',f=>f.artifact.versionId='new\nversion',f=>f.artifact.versionId='',f=>f.artifact.reused='true',
  f=>f.artifact.exactVersionReadbackVerified=false,f=>f.artifact.kmsKeyArn='other',f=>f.artifact.phiAllowed=true,
  f=>f.current.migrations.liveMigrationCount=47,f=>f.candidate.bundle[0]^=1]){
  const f=fixture();mutate(f);assert.throws(()=>inputs(f));
 }
});
test('proposal refuses stale or changed full controls and any candidate/input identity drift',()=>{
 for(const mutate of [f=>f.raw.fn.RevisionId+='changed',f=>f.raw.fn.Environment.Variables.EXTRA='value',
  f=>f.raw.routes.Items.pop(),f=>f.raw.routes.NextToken='page',f=>f.raw.resources.NextToken='page',
  f=>f.raw.role.Role.AssumeRolePolicyDocument.Statement[0].Principal.Service='other',
  f=>f.raw.stack.Stacks[0].StackStatus='UPDATE_IN_PROGRESS',f=>f.raw.template.Resources.IdentityApiFunction.Properties.Timeout=30,
  f=>f.input.parameters[0].ParameterValue='changed',f=>f.binding.stackId+='changed',f=>f.binding.name+='changed',
  f=>f.binding.id+='/',f=>f.binding.id=f.binding.id.replace(P.account,'173535830222')]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('both raw inventories reject unknown resources, pages, metadata, nested/import/drift/rollback authority',()=>{
 for(const mutate of [f=>f.summary.Changes.push(structuredClone(f.summary.Changes[0])),f=>f.summary.Changes.reverse(),
  f=>f.summary.Changes[1].ResourceChange.Details[0].CausingEntity='Other.Arn',
  f=>f.summary.Changes[1].ResourceChange.Details[0].Target.RequiresRecreation='Always',
  f=>f.summary.Changes[1].ResourceChange.Replacement='True',f=>f.detailed.Changes.push(structuredClone(f.summary.Changes[1])),
  f=>f.summary.NextToken='more',f=>f.detailed.NextToken='more',f=>f.summary.ExecutionStatus='EXECUTE_COMPLETE',
  f=>f.summary.DeploymentConfig.DisableRollback=true,f=>f.summary.RootChangeSetId='parent',
  f=>f.summary.NotificationARNs.push('other'),f=>f.summary.Tags=[{Key:'PhiAllowed',Value:'true'}],
  f=>f.summary.ImportExistingResources=true,f=>f.summary.IncludeNestedStacks=true,
  f=>f.summary.DeploymentMode='REVERT_DRIFT',f=>f.summary.NewUnknownScope='unsafe',
  f=>f.summary.Changes[0].ResourceChange.ModuleInfo={},f=>f.detailed.Parameters.pop(),
  f=>{f.summary.Description='different release';f.detailed.Description='different release';},
  f=>{f.summary.CreationTime='invalid';f.detailed.CreationTime='invalid';}]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('full property context refuses hidden non-code differences or incorrect current predecessor',()=>{
 for(const mutate of [f=>f.before.Properties.Code.S3ObjectVersion='old-parent-version',
  f=>f.before.Properties.Code.S3Key=f.before.Properties.Code.S3Key.replace('care-registered-release','care-intent-release'),
  f=>f.before.Properties.Role+='changed',f=>f.after.Properties.Environment.Variables.PHI_ALLOWED='true',
  f=>f.after.Properties.MemorySize='512',f=>f.after.Properties.Timeout='30',f=>f.after.Properties.Code.S3Bucket='other',
  f=>f.after.Properties.Code.S3ObjectVersion='wrong',f=>f.after.Properties.NewUnknownFeature=true,
  f=>f.after.Metadata={unsafe:true},f=>f.before.Properties.Environment.Variables.CLINICAL_DATABASE_SECRET_ARN=P.secret]){
  const f=fixture();mutate(f);context(f);assert.throws(()=>verify(f));
 }
});
test('two leaf deltas must exactly match contexts and explain key and version once, with no mutation-capable extra fields',()=>{
 const params=fixture();const key=params.detailed.Changes[0].ResourceChange.Details[1];
 key.ChangeSource='ParameterReference';key.CausingEntity='LambdaCodeKey';assert.doesNotThrow(()=>verify(params));
 for(const mutate of [f=>f.detailed.Changes[0].ResourceChange.Details.pop(),
  f=>f.detailed.Changes[0].ResourceChange.Details.push(structuredClone(f.detailed.Changes[0].ResourceChange.Details[0])),
  f=>f.detailed.Changes[0].ResourceChange.Details[1]=structuredClone(f.detailed.Changes[0].ResourceChange.Details[0]),
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.Path='/Properties/Role',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.BeforeValue='wrong',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='wrong',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Evaluation='Dynamic',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].ChangeSource='ParameterReference',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].HiddenMutation=true,
  f=>f.detailed.Changes[0].ResourceChange.BeforeContext='{}',f=>f.detailed.Changes[0].ResourceChange.SomeExtra=true]){
  const f=fixture();mutate(f);assert.throws(()=>verify(f));
 }
});
test('actual AWS dual evaluation of a parameter key admits only the complete exact three-detail projection',()=>{
 const observed=()=>{
  const f=fixture(),details=f.detailed.Changes[0].ResourceChange.Details,
   version=structuredClone(details[0]),key=structuredClone(details[1]);
  key.Evaluation='Dynamic';
  const parameter={...structuredClone(key),Evaluation:'Static',ChangeSource:'ParameterReference',CausingEntity:'LambdaCodeKey'};
  f.detailed.Changes[0].ResourceChange.Details=[key,version,parameter];return f;
 };
 for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
  const f=observed(),details=f.detailed.Changes[0].ResourceChange.Details;
  f.detailed.Changes[0].ResourceChange.Details=order.map(i=>details[i]);
  const result=verify(f);assert.equal(result.executionAdmissible,false);assert.equal(result.deployed,false);
 }
 for(const mutate of [f=>f.detailed.Changes[0].ResourceChange.Details.pop(),
  f=>f.detailed.Changes[0].ResourceChange.Details.push(structuredClone(f.detailed.Changes[0].ResourceChange.Details[0])),
  f=>f.detailed.Changes[0].ResourceChange.Details[2]=structuredClone(f.detailed.Changes[0].ResourceChange.Details[0]),
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.AfterValue='different-key',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].Target.BeforeValue='different-predecessor',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].CausingEntity='OtherKey',
  f=>f.detailed.Changes[0].ResourceChange.Details[2].Evaluation='Dynamic',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].Target.Path='/Properties/Role',
  f=>f.detailed.Changes[0].ResourceChange.Details[0].HiddenMutation=true,
  f=>f.detailed.Changes[0].ResourceChange.Details[1].Evaluation='Dynamic',
  f=>{f.after.Properties.Timeout='30';context(f);}]){
  const f=observed();mutate(f);assert.throws(()=>verify(f));
 }
});
test('bounded context parser detects duplicate decoded keys at any depth without rejecting whitespace or escapes',()=>{
 assert.deepEqual(parseRegisteredPropertyContext(' { "a": [1, true, null, "x,}:\\\""], "b":{} } '),{a:[1,true,null,'x,}:"'],b:{}});
 for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":1}','{"Properties":{"Code":{},"Code":{}}}',
  '{"a":[{"x":1,"x":2}]}','[1,]','{"a":1} trailing',' '.repeat(65537), '['.repeat(34)+'0'+']'.repeat(34)]){
  assert.throws(()=>parseRegisteredPropertyContext(text));
 }
 const f=fixture();f.detailed.Changes[0].ResourceChange.AfterContext=f.detailed.Changes[0].ResourceChange.AfterContext
  .replace('"Timeout":"29"','"Timeout":"99","Timeout":"29"');assert.throws(()=>verify(f),/duplicate_property_context/);
});
test('qualification module has no AWS call, execution, ledger replay or mobile build surface',()=>{
 const source=readFileSync(new URL('./catalog-runtime-code-change.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/execFile|client\.send|execute-change-set|update-stack|update-function-code|process\.env|process\.argv/);
 assert.match(source,/executionAdmissible:false/);assert.match(source,/verifyCatalogRuntimePredecessorControl\(raw,source\)/);
});
