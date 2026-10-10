if (typeof window !== 'undefined') throw Error('fictional mapping observation is server-only');
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, DescribeSecretCommand, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { fixtureIdentity, fixtureBindingHash, fixtureSecretName, validateFixtureIntent, inspectFixtureUser } from './inventory-qualification-fixtures';
import { observeInventoryIdentityConfiguration, observeInventoryIdentityDependency } from './inventory-qualification-identity-dependency';
import { inventoryCanonical, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import type { FictionalIdentityMapping } from './inventory-qualification-identity-mapping';

/** Reads the existing create-only intent and exactly its three users. No account
 * creation, password reset, MFA alteration, token issuance or approval writes.
 * Secret values are scoped to this function and never returned or logged. */
export async function observeFictionalInventoryMapping(): Promise<FictionalIdentityMapping> {
  await observeInventoryIdentityConfiguration(fixtureIdentity);
  const config = { region: 'us-east-2', maxAttempts: 1,
    credentials: fromIni({ profile: 'ai-synthetic-member', clientConfig: { region: 'us-east-2', endpoint: 'https://sts.us-east-2.amazonaws.com' } }) };
  const secrets = new SecretsManagerClient({ ...config, endpoint: 'https://secretsmanager.us-east-2.amazonaws.com' });
  const cognito = new CognitoIdentityProviderClient({ ...config, endpoint: 'https://cognito-idp.us-east-2.amazonaws.com' });
  const options = () => ({ abortSignal: AbortSignal.timeout(30000) });
  const refuse = (): never => inventoryRefuse('fictional_mapping_observation_refused');
  const tags = { Purpose: 'isolated-inventory-qualification-fixtures', ContainsPhi: 'false', BindingSha256: fixtureBindingHash };
  try {
    const load = async () => {
      const d = await secrets.send(new DescribeSecretCommand({ SecretId: fixtureSecretName }), options());
      if (d.Name !== fixtureSecretName || !d.ARN?.startsWith(`arn:aws:secretsmanager:us-east-2:588966314750:secret:${fixtureSecretName}-`)
        || d.DeletedDate || !Array.isArray(d.Tags) || d.Tags.length !== 3 || new Set(d.Tags.map(t => t.Key)).size !== 3
        || d.Tags.some(t => !t.Key || tags[t.Key as keyof typeof tags] !== t.Value)) return refuse();
      const v = await secrets.send(new GetSecretValueCommand({ SecretId: d.ARN, VersionStage: 'AWSCURRENT' }), options());
      if (v.ARN !== d.ARN || v.Name !== fixtureSecretName || v.SecretBinary || !v.VersionStages?.includes('AWSCURRENT')
        || typeof v.SecretString !== 'string' || Buffer.byteLength(v.SecretString) > 16384) return refuse();
      return validateFixtureIntent(JSON.parse(v.SecretString));
    };
    const intent = await load(), subjects = {} as FictionalIdentityMapping['subjects'], people = {} as FictionalIdentityMapping['people'];
    for (const role of ['consumer', 'foreignConsumer', 'workforce'] as const) {
      const UserPoolId = (role === 'workforce' ? fixtureIdentity.workforceIssuer : fixtureIdentity.consumerIssuer).split('/').at(-1)!;
      const raw = await cognito.send(new AdminGetUserCommand({ UserPoolId, Username: intent.fixtures[role].email }), options());
      const u = inspectFixtureUser(raw, intent.fixtures[role], intent.organizationId);
      if (!u.confirmed) return refuse();
      subjects[role] = u.subject; people[role] = intent.fixtures[role].personId;
    }
    const observed = await observeInventoryIdentityDependency({ identity: fixtureIdentity, organizationId: intent.organizationId, subjects });
    const personBindingsSha256 = inventorySha(inventoryCanonical(people));
    if (observed.personBindingsSha256 !== personBindingsSha256 || inventoryCanonical(await load()) !== inventoryCanonical(intent)) return refuse();
    return { bindingSha256: fixtureBindingHash, organizationId: intent.organizationId, people, subjects, personBindingsSha256 };
  } catch { return refuse(); }
  finally { secrets.destroy(); cognito.destroy(); }
}
