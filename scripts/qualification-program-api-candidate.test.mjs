import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const template = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/qualification-program-api-candidate.json', import.meta.url), 'utf8'));

test('candidate is a generated, drift-checked source projection', () => {
  execFileSync(process.execPath, ['scripts/build-qualification-program-api.mjs', '--check'], { cwd: root });
});

test('only the isolated fictional qualification target can satisfy parameters', () => {
  assert.equal(template.Metadata.ClinicalCore.PhiAllowed, false);
  assert.equal(template.Metadata.ClinicalCore.Activation, 'blocked');
  assert.deepEqual(template.Parameters.ClinicalApiId.AllowedValues, ['6zt8e9qz04']);
  assert.deepEqual(template.Parameters.DatabaseName.AllowedValues, ['clinical_core_qualification']);
  assert.deepEqual(template.Parameters.LambdaCodeBucket.AllowedValues, ['alp-qualification-code-588966314750-us-east-2']);
  for (const key of ['DatabaseClusterArn', 'ClinicalCoreKeyArn', 'AlarmTopicArn']) {
    assert.equal(template.Parameters[key].AllowedValues.length, 1);
    assert.match(template.Parameters[key].AllowedValues[0], /:us-east-2:588966314750:/);
  }
  assert.deepEqual(template.Parameters.WorkforceUserPoolId.AllowedValues, ['us-east-2_ueGlFRbNB']);
  assert.deepEqual(template.Parameters.ConsumerUserPoolId.AllowedValues, ['us-east-2_nYngyyYGE']);
  const env = template.Resources.IdentityApiFunction.Properties.Environment.Variables;
  assert.equal(env.PHI_ALLOWED, 'false');
  assert.equal(env.QUALIFICATION_EXECUTION, 'programs');
  assert.equal(env.DEPLOYMENT_ACCOUNT_ID, '588966314750');
  assert.deepEqual(env.CLINICAL_DATABASE_NAME, { Ref: 'DatabaseName' });
  assert.deepEqual(template.Resources.IdentityApiLogGroup.Properties.LogGroupName,
    { 'Fn::Sub': '/aws/lambda/${ClinicalApiId}-qualification-programs' });
  assert.equal(template.Resources.IdentityApiErrorAlarm.Properties.AlarmName,
    'ai-clinical-core-qualification-program-api-errors');
});

test('overlay owns only two JWT-protected program routes and narrow invoke grants', () => {
  const resources = template.Resources;
  const routes = Object.values(resources).filter(value => value.Type === 'AWS::ApiGatewayV2::Route');
  assert.deepEqual(routes.map(value => value.Properties.RouteKey).sort(), [
    'POST /clinical-core/consumer/programs',
    'POST /clinical-core/workforce/programs',
  ]);
  assert.ok(routes.every(value => value.Properties.AuthorizationType === 'JWT'));
  assert.equal(Object.values(resources).filter(value => value.Type === 'AWS::ApiGatewayV2::Stage').length, 0);
  const permissions = Object.values(resources).filter(value => value.Type === 'AWS::Lambda::Permission');
  assert.equal(permissions.length, 2);
  assert.ok(permissions.every(value => !value.Properties.SourceArn['Fn::Sub'].includes('/clinical-core/*')));
  assert.ok(permissions.every(value => value.Properties.SourceArn['Fn::Sub'].includes('/POST/clinical-core/')));
  const actions = resources.IdentityApiRole.Properties.Policies.flatMap(policy => policy.PolicyDocument.Statement)
    .flatMap(statement => statement.Action);
  assert.ok(!actions.some(action => action === '*' || action.startsWith('ses:') || action.startsWith('s3:')));
});
