import assert from 'node:assert/strict';
import test from 'node:test';
import { assessOperatorIdentity } from './verify-fictional-operator-identity-hosted-20261016.mjs';

function fixture() {
  const poolId = 'us-east-2_example';
  const clientId = 'exampleclient';
  return {
    caller: { Account: '588966314750',
      Arn: 'arn:aws:sts::588966314750:assumed-role/TestMember/fictional' },
    stack: { StackName: 'alp-platform-operator-identity-qualification', StackStatus: 'CREATE_COMPLETE' },
    changeSet: { ChangeSetId:
      'arn:aws:cloudformation:us-east-2:588966314750:changeSet/prepare-operator-identity-286ebc87-20261016/127313f0-94c7-46b1-8d4a-a29ebbdb58ef',
    ExecutionStatus: 'EXECUTE_COMPLETE' },
    resources: { StackResources: [
      { LogicalResourceId: 'OperatorPool', ResourceType: 'AWS::Cognito::UserPool',
        ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: poolId },
      { LogicalResourceId: 'OperatorClient', ResourceType: 'AWS::Cognito::UserPoolClient',
        ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: clientId },
    ] },
    pool: { Id: poolId, Name: 'alp-platform-operator-qualification',
      MfaConfiguration: 'ON', EnabledMfas: null,
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      DeletionProtection: 'ACTIVE', UserPoolTier: 'ESSENTIALS' },
    mfa: { MfaConfiguration: 'ON',
      SoftwareTokenMfaConfiguration: { Enabled: true },
      SmsMfaConfiguration: null, EmailMfaConfiguration: null },
    client: { ClientId: clientId, UserPoolId: poolId,
      ClientName: 'alp-platform-operator-qualification-server',
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH'] },
    users: { Users: [] },
  };
}

test('exact two-resource fictional pool is configuration-only, never clinical authority', () => {
  assert.deepEqual(assessOperatorIdentity(fixture()), {
    contract: 'fictional-operator-identity-hosted/1',
    account: '588966314750', region: 'us-east-2',
    stackName: 'alp-platform-operator-identity-qualification',
    poolCreated: true, clientCreated: true, mfaTotpRequired: true,
    selfSignupDisabled: true, usersCreated: false,
    clinicAccessVerified: false, phiAllowed: false,
    verdict: 'configuration_only_not_operator_sign_in_or_clinical_authority',
  });
});

test('wrong account, incomplete stack, replacement resource and users refuse', () => {
  for (const mutate of [
    value => { value.caller.Account = '173535830222'; },
    value => { value.stack.StackStatus = 'REVIEW_IN_PROGRESS'; },
    value => { value.changeSet.ExecutionStatus = 'AVAILABLE'; },
    value => { value.resources.StackResources.push({ LogicalResourceId: 'Other' }); },
    value => { value.users.Users.push({ Username: 'fictional@example.invalid' }); },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assessOperatorIdentity(value), /fictional_operator_identity_refused/);
  }
});
test('weaker MFA, enabled self-sign-up and client secret refuse', () => {
  for (const mutate of [
    value => { value.pool.MfaConfiguration = 'OPTIONAL'; },
    value => { value.mfa.MfaConfiguration = 'OPTIONAL'; },
    value => { value.mfa.SoftwareTokenMfaConfiguration.Enabled = false; },
    value => { value.mfa.SmsMfaConfiguration = { Enabled: true }; },
    value => { value.mfa.EmailMfaConfiguration = { Enabled: true }; },
    value => { value.pool.EnabledMfas = ['SMS_MFA']; },
    value => { value.pool.AdminCreateUserConfig.AllowAdminCreateUserOnly = false; },
    value => { value.client.ClientSecret = 'not-printed'; },
    value => { value.client.ExplicitAuthFlows = ['ALLOW_ADMIN_USER_PASSWORD_AUTH']; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assessOperatorIdentity(value), /fictional_operator_identity_refused/);
  }
});
