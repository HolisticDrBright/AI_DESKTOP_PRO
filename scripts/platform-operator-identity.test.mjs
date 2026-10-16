import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlatformOperatorIdentity, OPERATOR_ACCOUNT, OPERATOR_REGION } from './build-aws-platform-operator-identity.mjs';

test('operator pool is an isolated, synthetic-only blocked candidate', () => {
  const t = buildPlatformOperatorIdentity();
  assert.equal(OPERATOR_ACCOUNT, '588966314750');
  assert.equal(OPERATOR_REGION, 'us-east-2');
  assert.deepEqual(Object.keys(t.Resources).sort(), ['OperatorClient', 'OperatorPool']);
  assert.deepEqual(t.Conditions.SyntheticAccountAndRegion['Fn::And'], [
    { 'Fn::Equals': [{ Ref: 'AWS::AccountId' }, OPERATOR_ACCOUNT] },
    { 'Fn::Equals': [{ Ref: 'AWS::Region' }, OPERATOR_REGION] },
  ]);
  for (const resource of Object.values(t.Resources)) {
    assert.equal(resource.Condition, 'SyntheticAccountAndRegion');
    assert.equal(resource.DeletionPolicy, 'Retain');
    assert.equal(resource.UpdateReplacePolicy, 'Retain');
  }
  assert.equal(t.Metadata.PlatformOperatorIdentity.Activation, 'blocked');
  assert.equal(t.Metadata.PlatformOperatorIdentity.ContainsPhi, false);
  assert.equal(t.Metadata.PlatformOperatorIdentity.UsersCreated, false);
  assert.equal(t.Metadata.PlatformOperatorIdentity.OperatorRegistered, false);
  assert.equal(t.Outputs.PhiAllowed.Value, 'false');
  assert.equal(t.Outputs.Activation.Value, 'blocked');
  assert.throws(() => buildPlatformOperatorIdentity({ account: '173535830222' }), /options_refused/);
});

test('operator login cannot self-register, federate or use a non-TOTP factor', () => {
  const t = buildPlatformOperatorIdentity();
  const pool = t.Resources.OperatorPool.Properties;
  const client = t.Resources.OperatorClient.Properties;
  assert.equal(pool.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
  assert.equal(pool.MfaConfiguration, 'ON');
  assert.deepEqual(pool.EnabledMfas, ['SOFTWARE_TOKEN_MFA']);
  assert.equal(pool.DeletionProtection, 'ACTIVE');
  assert.equal(pool.Policies.PasswordPolicy.MinimumLength >= 14, true);
  assert.deepEqual(client.SupportedIdentityProviders, ['COGNITO']);
  assert.equal(client.AllowedOAuthFlowsUserPoolClient, false);
  assert.deepEqual(client.ExplicitAuthFlows, ['ALLOW_USER_PASSWORD_AUTH']);
  assert.equal(client.GenerateSecret, false); // The reviewed Desktop sign-in sends no SECRET_HASH.
  assert.equal(client.EnableTokenRevocation, true);
  assert.equal(client.PreventUserExistenceErrors, 'ENABLED');
  assert.equal(client.IdTokenValidity, 15);
  assert.equal(client.TokenValidityUnits.IdToken, 'minutes');
  assert.deepEqual(client.ReadAttributes, ['email', 'email_verified']);
  assert.deepEqual(client.WriteAttributes, ['email']);
});

test('template grants no operator, database, API or IAM authority', () => {
  const t = buildPlatformOperatorIdentity();
  const body = JSON.stringify(t);
  for (const forbidden of ['AWS::IAM::', 'AWS::Lambda::', 'AWS::ApiGateway', 'AWS::RDS::',
    'AWS::Cognito::UserPoolDomain', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH',
    'SMS_MFA', 'EMAIL_OTP', 'UserPoolClientSecret']) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
  assert.equal(t.Resources.OperatorClient.Properties.UserPoolId.Ref, 'OperatorPool');
  assert.equal(t.Outputs.OperatorClientId.Value.Ref, 'OperatorClient');
});
