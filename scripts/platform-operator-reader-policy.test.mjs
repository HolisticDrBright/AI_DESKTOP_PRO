import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlatformOperatorReaderPolicy, EXACT_OPERATOR_POOL_ARN } from './build-aws-platform-operator-reader-policy.mjs';

test('reader is conditional, blocked, unattached and bound to the exact fictional pool ARN', () => {
  const t = buildPlatformOperatorReaderPolicy();
  const p = t.Resources.OperatorPoolReader;
  assert.deepEqual(Object.keys(t.Resources), ['OperatorPoolReader']);
  assert.equal(p.Type, 'AWS::IAM::ManagedPolicy');
  assert.equal(p.Condition, 'SyntheticAccountAndRegion');
  assert.equal(p.DeletionPolicy, 'Retain');
  assert.equal(p.UpdateReplacePolicy, 'Retain');
  assert.equal(p.Properties.Roles, undefined);
  assert.equal(p.Properties.Users, undefined);
  assert.equal(p.Properties.Groups, undefined);
  assert.equal(p.Properties.ManagedPolicyName, undefined);
  assert.equal(t.Metadata.PlatformOperatorReader.Attached, false);
  assert.equal(t.Outputs.Attached.Value, 'false');
  assert.equal(t.Outputs.Activation.Value, 'blocked');
  assert.equal(t.Outputs.PhiAllowed.Value, 'false');
  assert.deepEqual(t.Conditions.SyntheticAccountAndRegion['Fn::And'], [
    { 'Fn::Equals': [{ Ref: 'AWS::AccountId' }, '588966314750'] },
    { 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'us-east-2'] },
  ]);
  const arn = new RegExp(EXACT_OPERATOR_POOL_ARN);
  assert.equal(arn.test('arn:aws:cognito-idp:us-east-2:588966314750:userpool/us-east-2_123456789'), true);
  assert.equal(arn.test('arn:aws:cognito-idp:us-east-2:173535830222:userpool/us-east-2_123456789'), false);
  assert.equal(arn.test('arn:aws:cognito-idp:us-east-2:588966314750:userpool/us-east-2_123456789*'), false);
  assert.throws(() => buildPlatformOperatorReaderPolicy({ pool: '*' }), /options_refused/);
});

test('reader grants only two Cognito reads and no wildcard or clinical authority', () => {
  const t = buildPlatformOperatorReaderPolicy();
  const statements = t.Resources.OperatorPoolReader.Properties.PolicyDocument.Statement;
  assert.equal(t.Resources.OperatorPoolReader.Properties.PolicyDocument.Version, '2012-10-17');
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, ['cognito-idp:DescribeUserPool', 'cognito-idp:AdminGetUser']);
  assert.deepEqual(statements[0].Resource, { Ref: 'OperatorPoolArn' });
  assert.equal(statements[0].Effect, 'Allow');
  const body = JSON.stringify(t);
  for (const forbidden of ['"Resource":"*"', 'cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser',
    'cognito-idp:AdminUpdateUserAttributes', 'secretsmanager:', 'rds-data:', 'execute-api:', 'dynamodb:']) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
});
