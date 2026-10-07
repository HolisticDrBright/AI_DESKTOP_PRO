import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CARE_RELEASE as P} from './synthetic-care-release.mjs';
import {careCodeChangeInputs, verifyCareCodeChangeSet} from './prepare-synthetic-care-code-change.mjs';
const source = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/identity-api-extension.json', import.meta.url), 'utf8'));
function example() {
  const template = structuredClone(source); for (const name of P.absentRoutes) delete template.Resources[name];
  template.Outputs.RoutesEnabled.Value = '51';
  const manifest = {key: 'fictional-key', zipSha256: 'a'.repeat(64), zipBytes: 123};
  const artifact = {bucket: P.bucket, key: manifest.key, sha256: manifest.zipSha256, bytes: 123,
    exactVersionReadbackVerified: true, encryption: 'aws:kms', kmsKeyArn: P.keyArn, versionId: 'fictional-version'};
  const parameters = Object.keys(source.Parameters).map(ParameterKey => ParameterKey === 'LambdaCodeKey'
    ? {ParameterKey, ParameterValue: manifest.key} : {ParameterKey, UsePreviousValue: true});
  return {template, manifest, artifact, parameters};
}
test('pins exact verified S3 version, code key only; no resources, role, routes or schema settings change', () => {
  const e = example(), before = structuredClone(e);
  const actual = careCodeChangeInputs(source, e.template, e.parameters, e.manifest, e.artifact);
  const restored = structuredClone(actual.template);
  delete restored.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion;
  assert.deepEqual(restored, e.template); assert.deepEqual(actual.parameters, e.parameters); assert.deepEqual(e, before);
  assert.equal(actual.template.Resources.IdentityApiFunction.Properties.Code.S3ObjectVersion, 'fictional-version');
  for (const mutate of [e => e.template.Resources.IdentityApiFunction.Properties.Timeout = 30,
    e => e.template.Resources.PublicConsultIntakeRoute = source.Resources.PublicConsultIntakeRoute,
    e => e.template.Metadata.ClinicalCore.ContainsPhi = true, e => e.parameters.pop(),
    e => e.parameters[0].UsePreviousValue = false, e => e.parameters.push(e.parameters[0]),
    e => e.artifact.bucket = 'other', e => e.artifact.key = 'other', e => e.artifact.sha256 = 'f'.repeat(64),
    e => e.artifact.bytes++, e => e.artifact.versionId = 'null', e => e.artifact.versionId = '',
    e => e.artifact.kmsKeyArn = 'other', e => e.artifact.exactVersionReadbackVerified = false]) {
    const changed = example(); mutate(changed);
    assert.throws(() => careCodeChangeInputs(source, changed.template, changed.parameters, changed.manifest, changed.artifact));
  }
});
function reviewed() {
  const e = example(), input = careCodeChangeInputs(source, e.template, e.parameters, e.manifest, e.artifact);
  const name = 'care-release-fictional', binding = {name, id: `arn:aws:cloudformation:${P.region}:${P.account}:changeSet/${name}/fictional`,
    stackId: `arn:aws:cloudformation:${P.region}:${P.account}:stack/${P.stack}/fictional`};
  const params = {ClinicalApiId: P.apiId, DatabaseName: P.database, DatabaseClusterArn: P.cluster, DatabaseSecretArn: '****',
    ConsumerUserPoolId: P.consumerPool, ConsumerUserPoolClientId: P.consumerClient, WorkforceUserPoolId: P.workforcePool,
    WorkforceUserPoolClientId: P.workforceClient, ClinicalCoreKeyArn: P.keyArn, LambdaCodeBucket: P.bucket, LambdaCodeKey: e.manifest.key};
  const set = {StackId: binding.stackId, StackName: P.stack, ChangeSetName: name, ChangeSetId: binding.id,
    Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Capabilities: ['CAPABILITY_IAM'],
    Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ParameterKey, ParameterValue})),
    Changes: [{Type: 'Resource', ResourceChange: {Action: 'Modify', LogicalResourceId: 'IdentityApiFunction',
      PhysicalResourceId: P.functionName, ResourceType: 'AWS::Lambda::Function', Replacement: 'False', Scope: ['Properties'],
      Details: [{Target: {Attribute: 'Properties', Name: 'Code', RequiresRecreation: 'Never'}, ChangeSource: 'DirectModification'},
        {Target: {Attribute: 'Properties', Name: 'Code', RequiresRecreation: 'Never'}, ChangeSource: 'ParameterReference', CausingEntity: 'LambdaCodeKey'}]}}]};
  return {input, binding, set};
}
test('only one existing Lambda code modification can be marked reviewable, never executable evidence', () => {
  const r = reviewed(); verifyCareCodeChangeSet(r.set, r.input.template, r.input, r.binding);
  for (const mutate of [r => r.set.StackId = 'other', r => r.set.ChangeSetId = 'other', r => r.set.Status = 'FAILED',
    r => r.set.ExecutionStatus = 'EXECUTE_COMPLETE', r => r.set.Capabilities.push('CAPABILITY_AUTO_EXPAND'),
    r => r.set.NextToken = 'more-results', r => r.set.IncludeNestedStacks = true, r => r.set.ImportExistingResources = true,
    r => r.set.Parameters.pop(), r => r.set.Parameters.push(r.set.Parameters[0]),
    r => r.set.Parameters[0] = {ParameterKey: 'unknown'}, r => r.set.Parameters[0].ParameterValue = 'other',
    r => r.set.Changes.push(structuredClone(r.set.Changes[0])), r => r.set.Changes[0].ResourceChange.Action = 'Add',
    r => r.set.Changes[0].ResourceChange.LogicalResourceId = 'IdentityApiRole',
    r => r.set.Changes[0].ResourceChange.Replacement = 'True',
    r => r.set.Changes[0].ResourceChange.Details[0].Target.Name = 'Environment',
    r => r.set.Changes[0].ResourceChange.Details[1].CausingEntity = 'DatabaseName']) {
    const changed = reviewed(); mutate(changed);
    assert.throws(() => verifyCareCodeChangeSet(changed.set, changed.input.template, changed.input, changed.binding));
  }
  const otherTemplate = structuredClone(r.input.template); otherTemplate.Resources.IdentityApiFunction.Properties.Timeout = 30;
  assert.throws(() => verifyCareCodeChangeSet(r.set, otherTemplate, r.input, r.binding));
});
test('CLI can create and inspect a change set but has no execution or database mutation method', () => {
  const script = readFileSync(new URL('./prepare-synthetic-care-code-change.mjs', import.meta.url), 'utf8');
  assert.match(script, /'create-change-set'/); assert.match(script, /'describe-change-set'/);
  assert.doesNotMatch(script, /'execute-change-set'|'update-stack'|'update-function-code'|'execute-statement'|'commit-transaction'/);
});
