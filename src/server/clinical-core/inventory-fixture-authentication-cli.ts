import { fromIni } from '@aws-sdk/credential-provider-ini';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminInitiateAuthCommand, AdminRespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand, AdminSetUserMFAPreferenceCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, GetSecretValueCommand, DescribeSecretCommand, CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { InventoryQualificationError, inventoryRefuse } from './inventory-qualification-artifacts';
import { observeInventoryIdentityConfiguration } from './inventory-qualification-identity-dependency';
import { fixtureIdentity, fixtureBindingHash, fixtureSecretName } from './inventory-qualification-fixtures';
import { authenticateFictionalFixtures, mfaBindingHash, mfaSecretRoot } from './inventory-fixture-authentication';

async function main() {
  if (process.argv.slice(2).join(' ') !== '--authenticate-fictional-fixtures') return inventoryRefuse('fictional_authentication_argument_refused');
  const config = { region: 'us-east-2', credentials: fromIni({ profile: 'ai-synthetic-member' }), maxAttempts: 1 };
  const cognito = new CognitoIdentityProviderClient({ ...config, endpoint: 'https://cognito-idp.us-east-2.amazonaws.com' });
  const secrets = new SecretsManagerClient({ ...config, endpoint: 'https://secretsmanager.us-east-2.amazonaws.com' });
  const options = () => ({ abortSignal: AbortSignal.timeout(30000) });
  const tags = (purpose: string) => ({ Purpose: purpose, ContainsPhi: 'false', BindingSha256: fixtureBindingHash });
  const errorName = (e: unknown) => e && typeof e === 'object' && 'name' in e ? e.name : '';
  const load = async (name: string, purpose: string): Promise<unknown | null> => {
    let d;
    try { d = await secrets.send(new DescribeSecretCommand({ SecretId: name }), options()); }
    catch (e) { if (errorName(e) === 'ResourceNotFoundException') return null; throw Error('fictional_secret_read_not_completed'); }
    const expected = tags(purpose);
    if (d.Name !== name || !d.ARN?.startsWith(`arn:aws:secretsmanager:us-east-2:588966314750:secret:${name}-`)
      || d.DeletedDate || !Array.isArray(d.Tags) || d.Tags.length !== 3 || new Set(d.Tags.map(t => t.Key)).size !== 3
      || d.Tags.some(t => !t.Key || expected[t.Key as keyof typeof expected] !== t.Value)) return inventoryRefuse('fictional_secret_binding_refused');
    const v = await secrets.send(new GetSecretValueCommand({ SecretId: d.ARN, VersionStage: 'AWSCURRENT' }), options());
    if (v.ARN !== d.ARN || v.Name !== name || v.SecretBinary || !v.VersionStages?.includes('AWSCURRENT')
      || typeof v.SecretString !== 'string' || Buffer.byteLength(v.SecretString) > 16384) return inventoryRefuse('fictional_secret_shape_refused');
    return JSON.parse(v.SecretString);
  };
  try {
    const result = await authenticateFictionalFixtures({
      now: () => Date.now(),
      verifyPrivateConfiguration: async () => { await observeInventoryIdentityConfiguration(fixtureIdentity); },
      loadIntent: () => load(fixtureSecretName, 'isolated-inventory-qualification-fixtures'),
      readUser: (UserPoolId, Username) => cognito.send(new AdminGetUserCommand({ UserPoolId, Username }), options()),
      initiate: (UserPoolId, ClientId, USERNAME, PASSWORD) => cognito.send(new AdminInitiateAuthCommand({
        UserPoolId, ClientId, AuthFlow: 'ADMIN_USER_PASSWORD_AUTH', AuthParameters: { USERNAME, PASSWORD } }), options()),
      respond: (UserPoolId, ClientId, USERNAME, ChallengeName, Session, code) => cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId, ClientId, ChallengeName, Session, ChallengeResponses: { USERNAME,
          ...(code === undefined ? {} : { SOFTWARE_TOKEN_MFA_CODE: code }) } }), options()),
      associate: Session => cognito.send(new AssociateSoftwareTokenCommand({ Session }), options()),
      verifySoftware: (Session, UserCode) => cognito.send(new VerifySoftwareTokenCommand({ Session, UserCode,
        FriendlyDeviceName: 'Fictional isolated qualification only' }), options()),
      preferSoftware: async (UserPoolId, Username) => { await cognito.send(new AdminSetUserMFAPreferenceCommand({
        UserPoolId, Username, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }), options()); },
      loadMfa: (binding, phase) => load(`${mfaSecretRoot}/${mfaBindingHash(binding)}/${phase}`, `isolated-fixture-mfa-${phase}`),
      createMfa: async (binding, phase, value) => {
        try { await secrets.send(new CreateSecretCommand({ Name: `${mfaSecretRoot}/${mfaBindingHash(binding)}/${phase}`,
          ClientRequestToken: phase === 'admission' ? ('nonce' in value ? value.nonce : '') : ('admission' in value ? value.admission.nonce : ''),
          SecretString: JSON.stringify(value), Description: 'Create-only fictional authenticator custody, not a human authenticator',
          Tags: Object.entries(tags(`isolated-fixture-mfa-${phase}`)).map(([Key, Value]) => ({ Key, Value })) }), options()); return true; }
        catch (e) { if (errorName(e) === 'ResourceExistsException') return false; throw Error('fictional_mfa_custody_write_not_observed'); }
      },
      jwks: async issuer => {
        if (issuer !== fixtureIdentity.consumerIssuer && issuer !== fixtureIdentity.workforceIssuer) return inventoryRefuse('fictional_jwks_origin_refused');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
        try {
          const url = `${issuer}/.well-known/jwks.json`;
          const response = await fetch(url, { redirect: 'error', signal: controller.signal, credentials: 'omit', headers: { accept: 'application/json' } });
          if (!response.ok || response.url !== url || !response.body) return inventoryRefuse('fictional_jwks_read_refused');
          const length = response.headers.get('content-length');
          if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65536)) return inventoryRefuse('fictional_jwks_size_refused');
          const chunks: Uint8Array[] = []; let count = 0; const reader = response.body.getReader();
          try { for (;;) { const part = await reader.read(); if (part.done) break;
            count += part.value.byteLength; if (count > 65536) { controller.abort(); return inventoryRefuse('fictional_jwks_size_refused'); }
            chunks.push(part.value); } }
          finally { reader.releaseLock(); }
          if (length !== null && Number(length) !== count) return inventoryRefuse('fictional_jwks_size_refused');
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally { clearTimeout(timer); }
      },
    });
    console.log(JSON.stringify(result));
  } finally { cognito.destroy(); secrets.destroy(); }
}
void main().catch(error => {
  const category = error instanceof InventoryQualificationError ? error.category : 'fictional_authentication_not_completed';
  console.error(JSON.stringify({ status: 'not_completed', category, credentialsLoginVerified: false,
    workforceMfaEnrollmentVerified: false, physicalLoginVerified: false, acceptance: false, phiAllowed: false }));
  process.exitCode = 1;
});
