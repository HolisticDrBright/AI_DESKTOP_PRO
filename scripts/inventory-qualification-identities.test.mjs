import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInventoryQualificationIdentities, IDENTITY_ACCOUNT, IDENTITY_REGION } from './build-inventory-qualification-identities.mjs';
test('isolated four-resource configuration cannot import a shared pool or activate production', () => {
  const t = buildInventoryQualificationIdentities();
  assert.equal(IDENTITY_ACCOUNT, '588966314750'); assert.equal(IDENTITY_REGION, 'us-east-2');
  assert.deepEqual(Object.keys(t.Parameters).sort(), ['SourceCommit', 'TemplateSha256']);
  assert.equal(t.Outputs.PhiAllowed.Value, 'false'); assert.equal(t.Outputs.Activation.Value, 'blocked');
  assert.equal(t.Outputs.Execution.Value, 'configuration_only');
  assert.deepEqual(t.Conditions.SyntheticAccountAndRegion, { 'Fn::And': [
    { 'Fn::Equals': [{ Ref: 'AWS::AccountId' }, IDENTITY_ACCOUNT] }, { 'Fn::Equals': [{ Ref: 'AWS::Region' }, IDENTITY_REGION] },
  ] });
  assert.equal(Object.keys(t.Resources).length, 4);
  for (const [name, r] of Object.entries(t.Resources)) {
    assert.equal(r.Condition, 'SyntheticAccountAndRegion'); assert.equal(r.DeletionPolicy, 'Retain'); assert.equal(r.UpdateReplacePolicy, 'Retain');
    assert.ok(['AWS::Cognito::UserPool', 'AWS::Cognito::UserPoolClient'].includes(r.Type));
    const p = r.Properties;
    if (r.Type === 'AWS::Cognito::UserPool') {
      assert.equal(p.MfaConfiguration, name.startsWith('Workforce') ? 'ON' : 'OPTIONAL');
      assert.equal(p.UserPoolTier, 'ESSENTIALS'); assert.equal(p.DeletionProtection, 'ACTIVE');
      assert.deepEqual(p.EnabledMfas, ['SOFTWARE_TOKEN_MFA']); assert.deepEqual(p.Policies.SignInPolicy.AllowedFirstAuthFactors, ['PASSWORD']);
      assert.equal(p.AdminCreateUserConfig.AllowAdminCreateUserOnly, true); assert.equal(p.UserPoolTags.ContainsPhi, 'false');
      assert.equal(p.Schema.length, 4); assert.ok(p.Schema.every(a => !a.Mutable && !a.Required));
      assert.equal(p.LambdaConfig, undefined); assert.equal(p.UserPoolAddOns, undefined); assert.equal(p.DeviceConfiguration, undefined);
    } else {
      assert.deepEqual(p.UserPoolId, { Ref: name.replace('Client', 'Pool') }); assert.equal(p.GenerateSecret, false);
      assert.deepEqual(p.WriteAttributes, ['email']); assert.equal(p.EnableTokenRevocation, true);
      assert.equal(p.PreventUserExistenceErrors, 'ENABLED'); assert.equal(p.AllowedOAuthFlowsUserPoolClient, false);
      assert.equal(p.CallbackURLs, undefined); assert.equal(p.RefreshTokenRotation, undefined);
    }
  }
  assert.equal(t.Metadata.QualificationIdentity.AccountsCreated, false);
  assert.equal(t.Metadata.QualificationIdentity.Acceptance, false);
  assert.equal(t.Metadata.QualificationIdentity.ExistingPoolsModified, false);
  assert.ok(!JSON.stringify(t).includes('173535830222'));
  for (const supplied of [{ PhiAllowed: true }, { Activation: 'approved' }, { Account: '173535830222' }, { ExistingPoolId: 'shared' }, undefined])
    assert.throws(() => buildInventoryQualificationIdentities(supplied), /inventory_identity_build_options_refused/);
});
