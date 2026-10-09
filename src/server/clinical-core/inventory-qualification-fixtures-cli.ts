import { fromIni } from '@aws-sdk/credential-provider-ini';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, GetSecretValueCommand, DescribeSecretCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { InventoryQualificationError, inventoryRefuse } from './inventory-qualification-artifacts';
import { observeInventoryIdentityConfiguration } from './inventory-qualification-identity-dependency';
import { fixtureIdentity, fixtureBindingHash, fixtureSecretName, provisionFictionalInventoryFixtures } from './inventory-qualification-fixtures';

async function main() {
  if (process.argv.slice(2).join(' ') !== '--provision-fictional-fixtures') return inventoryRefuse('fictional_fixture_argument_refused');
  const config = { region: 'us-east-2', credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1 };
  const cognito = new CognitoIdentityProviderClient({ ...config, endpoint: 'https://cognito-idp.us-east-2.amazonaws.com' });
  const secrets = new SecretsManagerClient({ ...config, endpoint: 'https://secretsmanager.us-east-2.amazonaws.com' });
  const options = () => ({ abortSignal: AbortSignal.timeout(30000) });
  const code = (e: unknown) => e && typeof e === 'object' && 'name' in e ? e.name : '';
  const tags = { Purpose: 'isolated-inventory-qualification-fixtures', ContainsPhi: 'false', BindingSha256: fixtureBindingHash };
  try {
    const result = await provisionFictionalInventoryFixtures({
      verifyPrivateConfiguration: async () => { await observeInventoryIdentityConfiguration(fixtureIdentity); },
      loadIntent: async () => {
        let d;
        try { d = await secrets.send(new DescribeSecretCommand({ SecretId: fixtureSecretName }), options()); }
        catch (e) { if (code(e) === 'ResourceNotFoundException') return null; throw Error('fixture_secret_read_failed'); }
        if (d.Name !== fixtureSecretName || !d.ARN?.startsWith(`arn:aws:secretsmanager:us-east-2:588966314750:secret:${fixtureSecretName}-`)
          || d.DeletedDate || !Array.isArray(d.Tags) || d.Tags.length !== 3
          || new Set(d.Tags.map(t => t.Key)).size !== 3 || d.Tags.some(t => !t.Key || tags[t.Key as keyof typeof tags] !== t.Value))
          return inventoryRefuse('fictional_fixture_secret_binding_refused');
        const v = await secrets.send(new GetSecretValueCommand({ SecretId: d.ARN, VersionStage: 'AWSCURRENT' }), options());
        if (v.ARN !== d.ARN || v.Name !== fixtureSecretName || v.SecretBinary || !v.VersionStages?.includes('AWSCURRENT')
          || typeof v.SecretString !== 'string' || Buffer.byteLength(v.SecretString) > 16384) return inventoryRefuse('fictional_fixture_secret_shape_refused');
        return JSON.parse(v.SecretString);
      },
      createIntent: async intent => {
        // The deterministic name has create-only semantics. Concurrent creators
        // converge by reading the persisted winner; no Update/PutSecret exists.
        try { await secrets.send(new CreateSecretCommand({ Name: fixtureSecretName,
          ClientRequestToken: intent.organizationId, SecretString: JSON.stringify(intent),
          Description: 'Private fictional inventory fixture credentials; no real users or PHI',
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }), options()); }
        catch (e) { if (code(e) !== 'ResourceExistsException') throw Error('fixture_secret_creation_not_observed'); }
      },
      readUser: async (UserPoolId, Username) => {
        try { return await cognito.send(new AdminGetUserCommand({ UserPoolId, Username }), options()); }
        catch (e) { if (code(e) === 'UserNotFoundException') return null; throw Error('fixture_user_read_failed'); }
      },
      createUser: async (UserPoolId, fixture, organizationId) => {
        try { await cognito.send(new AdminCreateUserCommand({ UserPoolId, Username: fixture.email,
          TemporaryPassword: fixture.password, MessageAction: 'SUPPRESS', ForceAliasCreation: false,
          UserAttributes: Object.entries({ email: fixture.email, email_verified: 'true', 'custom:person_id': fixture.personId,
            'custom:organization_id': organizationId, 'custom:synthetic_attested': 'true' }).map(([Name, Value]) => ({ Name, Value })) }), options()); }
        catch (e) { if (code(e) !== 'UsernameExistsException') throw Error('fixture_user_creation_not_observed'); }
      },
      confirmNewUser: async (UserPoolId, Username, Password) => {
        await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username, Password, Permanent: true }), options());
      },
    });
    console.log(JSON.stringify(result));
  } finally { cognito.destroy(); secrets.destroy(); }
}
void main().catch(error => {
  // Never emit SDK errors, request bodies, usernames, credentials or tokens.
  const category = error instanceof InventoryQualificationError ? error.category : 'fictional_fixture_operation_not_completed';
  console.error(JSON.stringify({ status: 'not_completed', category, fixtureAccountsObserved: false,
    physicalLoginVerified: false, liveFleetVerified: false, acceptance: false, phiAllowed: false }));
  process.exitCode = 1;
});
