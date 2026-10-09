import { expect, it } from 'vitest';
import { buildInventoryQualificationIdentities } from '../../../scripts/build-inventory-qualification-identities.mjs';
import { observeInventoryIdentityConfiguration } from './inventory-qualification-identity-dependency';
import type { InventoryServiceRead } from './inventory-qualification-service-observer';

it('rendered pool and public-client properties satisfy the same independent AWS configuration observer', async () => {
  const t = buildInventoryQualificationIdentities();
  const binding = { consumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer',
    workforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce',
    consumerAudience: 'c'.repeat(26), workforceAudience: 'w'.repeat(26) };
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    if (service === 'sts') return { Account: '588966314750', Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional' };
    const workforce = parameters.UserPoolId === 'us-east-2_Workforce', role = workforce ? 'Workforce' : 'Consumer';
    const pool = t.Resources[`${role}Pool`].Properties, client = t.Resources[`${role}Client`].Properties;
    if (operation === 'describe-user-pool') return { UserPool: { ...pool, Id: parameters.UserPoolId,
      Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${parameters.UserPoolId}`, LambdaConfig: {},
      SchemaAttributes: pool.Schema.map(a => ({ ...a, Name: `custom:${a.Name}` })) } };
    if (operation === 'describe-user-pool-client') return { UserPoolClient: { ...client, UserPoolId: parameters.UserPoolId,
      ClientId: workforce ? binding.workforceAudience : binding.consumerAudience, HasClientSecret: false } };
    if (operation === 'get-user-pool-mfa-config') return { MfaConfiguration: pool.MfaConfiguration, SoftwareTokenMfaConfiguration: { Enabled: true } };
    throw Error('fictional_unmodeled_read');
  };
  expect(await observeInventoryIdentityConfiguration(binding, read)).toMatchObject({ identityConfigurationVerified: true,
    observations: 7, designatedSyntheticSubjectsVerified: false, physicalLoginVerified: false, acceptance: false, phiAllowed: false });
});
