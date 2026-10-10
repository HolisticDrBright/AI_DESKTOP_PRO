import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ secret: vi.fn(), user: vi.fn(), configure: vi.fn(), dependency: vi.fn(), secretConfig: vi.fn(), userConfig: vi.fn(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-secrets-manager', () => ({ SecretsManagerClient: class { constructor(config: unknown) { f.secretConfig(config); } send = f.secret; destroy = f.destroy; },
  DescribeSecretCommand: class { constructor(readonly input: unknown) {} }, GetSecretValueCommand: class { constructor(readonly input: unknown) {} } }));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({ CognitoIdentityProviderClient: class { constructor(config: unknown) { f.userConfig(config); } send = f.user; destroy = f.destroy; },
  AdminGetUserCommand: class { constructor(readonly input: unknown) {} } }));
vi.mock('./inventory-qualification-identity-dependency', () => ({ observeInventoryIdentityConfiguration: f.configure, observeInventoryIdentityDependency: f.dependency }));
import { generateFixtureIntent, fixtureBindingHash, fixtureSecretName, type FixtureIntent } from './inventory-qualification-fixtures';
import { inventoryCanonical, inventorySha } from './inventory-qualification-artifacts';
import { observeFictionalInventoryMapping } from './inventory-qualification-identity-mapping-observer';
let intent: FixtureIntent;
const arn = `arn:aws:secretsmanager:us-east-2:588966314750:secret:${fixtureSecretName}-fictional`;
const description = () => ({ Name: fixtureSecretName, ARN: arn, Tags: [
  { Key: 'Purpose', Value: 'isolated-inventory-qualification-fixtures' }, { Key: 'ContainsPhi', Value: 'false' }, { Key: 'BindingSha256', Value: fixtureBindingHash },
] });
const secret = () => ({ ARN: arn, Name: fixtureSecretName, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(intent) });
beforeEach(() => {
  vi.clearAllMocks(); intent = generateFixtureIntent();
  f.configure.mockResolvedValue({});
  f.dependency.mockImplementation(async () => ({ personBindingsSha256: inventorySha(inventoryCanonical(Object.fromEntries(Object.entries(intent.fixtures).map(([key, value]) => [key, value.personId])))) }));
  f.secret.mockImplementation(async command => command.constructor.name === 'DescribeSecretCommand' ? description() : secret());
  f.user.mockImplementation(async command => {
    const fixture = Object.values(intent.fixtures).find(row => row.email === command.input.Username)!;
    const subject = `FictionalSubject_${fixture.personId}`;
    return { Enabled: true, UserStatus: 'CONFIRMED', Username: subject, UserAttributes: Object.entries({ sub: subject, email: fixture.email,
      email_verified: 'true', 'custom:person_id': fixture.personId, 'custom:organization_id': intent.organizationId, 'custom:synthetic_attested': 'true' }).map(([Name, Value]) => ({ Name, Value })) };
  });
});
it('reads exactly the private intent and three existing users; returns no credentials or authority approval', async () => {
  const result = await observeFictionalInventoryMapping();
  expect(result.organizationId).toBe(intent.organizationId); expect(result.people.consumer).toBe(intent.fixtures.consumer.personId);
  expect(f.user).toHaveBeenCalledTimes(3); expect(f.secret).toHaveBeenCalledTimes(4); expect(f.configure).toHaveBeenCalledTimes(1);
  expect(f.dependency).toHaveBeenCalledTimes(1); expect(f.destroy).toHaveBeenCalledTimes(2);
  for (const fixture of Object.values(intent.fixtures)) { expect(JSON.stringify(result)).not.toContain(fixture.email); expect(JSON.stringify(result)).not.toContain(fixture.password); }
  for (const command of f.secret.mock.calls.map(c => c[0])) expect(['DescribeSecretCommand', 'GetSecretValueCommand']).toContain(command.constructor.name);
  for (const command of f.user.mock.calls.map(c => c[0])) expect(command.constructor.name).toBe('AdminGetUserCommand');
  expect(f.secretConfig).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-2', maxAttempts: 1, endpoint: 'https://secretsmanager.us-east-2.amazonaws.com' }));
  expect(f.userConfig).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-2', maxAttempts: 1, endpoint: 'https://cognito-idp.us-east-2.amazonaws.com' }));
});
it('does not read secrets when private configuration is refused', async () => {
  f.configure.mockRejectedValueOnce(Error('fictional configuration refused'));
  await expect(observeFictionalInventoryMapping()).rejects.toThrow(); expect(f.secret).not.toHaveBeenCalled(); expect(f.user).not.toHaveBeenCalled();
});
it('refuses foreign account/name, deletion and wrong/missing/duplicated tags before credential access', async () => {
  for (const bad of [{ ...description(), ARN: arn.replace('588966314750', '173535830222') }, { ...description(), Name: 'other' },
    { ...description(), DeletedDate: new Date() }, { ...description(), Tags: [] },
    { ...description(), Tags: [{ Key: 'Purpose', Value: 'other' }, ...description().Tags.slice(1)] },
    { ...description(), Tags: [description().Tags[0], description().Tags[0], description().Tags[2]] }]) {
    f.secret.mockReset(); f.secret.mockResolvedValue(bad); f.user.mockClear();
    await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused');
    expect(f.secret).toHaveBeenCalledTimes(1); expect(f.user).not.toHaveBeenCalled();
  }
});
it('refuses wrong current version, binary or oversized credentials without emitting provider error', async () => {
  for (const bad of [{ ...secret(), VersionStages: [] }, { ...secret(), SecretBinary: new Uint8Array([1]) },
    { ...secret(), ARN: arn + '-other' }, { ...secret(), SecretString: 'x'.repeat(17000) }, { ...secret(), SecretString: '{' }]) {
    f.secret.mockReset(); f.secret.mockResolvedValueOnce(description()).mockResolvedValueOnce(bad); f.user.mockClear();
    await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused'); expect(f.user).not.toHaveBeenCalled();
  }
});
it('refuses missing MFA/configuration evidence, a person digest mismatch, or a replaced persisted intent', async () => {
  f.dependency.mockRejectedValueOnce(Error('fictional MFA refused'));
  await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused');
  f.dependency.mockResolvedValueOnce({ personBindingsSha256: 'a'.repeat(64) });
  await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused');
  let descriptions = 0;
  f.secret.mockImplementation(async command => {
    if (command.constructor.name === 'DescribeSecretCommand') { descriptions++; return description(); }
    return descriptions === 2 ? { ...secret(), SecretString: JSON.stringify(generateFixtureIntent()) } : secret();
  });
  await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused');
});
it('refuses a disabled/unconfirmed user and never resets or creates an account', async () => {
  f.user.mockResolvedValueOnce({ Enabled: false });
  await expect(observeFictionalInventoryMapping()).rejects.toThrow('fictional_mapping_observation_refused');
  expect(f.user).toHaveBeenCalledTimes(1);
});
