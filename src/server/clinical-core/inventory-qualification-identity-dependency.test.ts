import { expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventorySha } from './inventory-qualification-artifacts';
import { inventoryIdentityReader, observeInventoryIdentityConfiguration, observeInventoryIdentityDependency, type InventoryIdentityDependency } from './inventory-qualification-identity-dependency';
import type { InventoryServiceRead } from './inventory-qualification-service-observer';
type Row = Record<string, unknown>;
const obj = (v: unknown) => v as Row;
const org = '11111111-1111-4111-8111-111111111111';
const subjects = { consumer: '22222222-2222-4222-8222-222222222222', foreignConsumer: '33333333-3333-4333-8333-333333333333',
  workforce: '44444444-4444-4444-8444-444444444444' };
const poolId = (workforce: boolean) => `us-east-2_${workforce ? 'Workforce' : 'Consumer'}`;
const audience = (workforce: boolean) => (workforce ? 'w' : 'c').repeat(26);
function fixture() {
  const binding: InventoryIdentityDependency = { organizationId: org, subjects, identity: {
    consumerIssuer: `https://cognito-idp.us-east-2.amazonaws.com/${poolId(false)}`, consumerAudience: audience(false),
    workforceIssuer: `https://cognito-idp.us-east-2.amazonaws.com/${poolId(true)}`, workforceAudience: audience(true) } };
  const responses: Record<string, unknown> = { sts: { Account: '588966314750',
    Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional' } };
  for (const w of [false, true]) {
    responses[`describe-user-pool/${poolId(w)}`] = { UserPool: { Id: poolId(w),
      Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${poolId(w)}`, Status: 'Enabled', DeletionProtection: 'ACTIVE',
      UsernameAttributes: ['email'], UsernameConfiguration: { CaseSensitive: false }, AutoVerifiedAttributes: ['email'],
      MfaConfiguration: w ? 'ON' : 'OPTIONAL', AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      Policies: { PasswordPolicy: { MinimumLength: w ? 14 : 12, RequireLowercase: true, RequireNumbers: true,
        RequireSymbols: true, RequireUppercase: true, TemporaryPasswordValidityDays: 1 },
        SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } },
      UserPoolTags: { Environment: 'synthetic-staging', DataClassification: 'synthetic_only' }, LambdaConfig: {},
      SchemaAttributes: [['person_id', '36'], ['organization_id', '36'], ['synthetic_attested', '4'], ['production_bound', '4']].map(([Name, length]) =>
        ({ Name: `custom:${Name}`, AttributeDataType: 'String', Mutable: false, Required: false, DeveloperOnlyAttribute: false,
          StringAttributeConstraints: { MinLength: length, MaxLength: length } })) } };
    responses[`describe-user-pool-client/${poolId(w)}`] = { UserPoolClient: { UserPoolId: poolId(w), ClientId: audience(w),
      HasClientSecret: false, PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, AccessTokenValidity: 15,
      IdTokenValidity: 15, RefreshTokenValidity: 12, TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'hours' },
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      ReadAttributes: ['email', 'email_verified', 'custom:person_id', 'custom:organization_id', 'custom:synthetic_attested', 'custom:production_bound'],
      WriteAttributes: ['email'], SupportedIdentityProviders: ['COGNITO'] } };
    responses[`get-user-pool-mfa-config/${poolId(w)}`] = { MfaConfiguration: w ? 'ON' : 'OPTIONAL', SoftwareTokenMfaConfiguration: { Enabled: true } };
  }
  for (const [n, subject] of Object.values(subjects).entries()) {
    const w = n === 2;
    responses[`admin-get-user/${subject}`] = { Enabled: true, UserStatus: 'CONFIRMED', UserMFASettingList: w ? ['SOFTWARE_TOKEN_MFA'] : [],
      ...(w ? { PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA' } : {}), UserAttributes: [
        { Name: 'sub', Value: subject }, { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:person_id', Value: `${n + 5}`.repeat(8) + '-5555-4555-8555-555555555555' },
        { Name: 'custom:synthetic_attested', Value: 'true' }, { Name: 'custom:organization_id', Value: org }] };
  }
  const calls: Array<[string, string, Record<string, string | string[]>]> = [];
  const read: InventoryServiceRead = async (s, o, p) => {
    calls.push([s, o, structuredClone(p)]);
    const key = s === 'sts' ? 'sts' : `${o}/${o === 'admin-get-user' ? p.Username : p.UserPoolId}`;
    if (!Object.hasOwn(responses, key)) throw Error('fictional_unmodeled_read');
    return structuredClone(responses[key]);
  };
  return { binding: structuredClone(binding), responses, read, calls };
}

it('independently repeats pool/client/MFA and exact designated-user observations without certifying database authority', async () => {
  const f = fixture(), r = await observeInventoryIdentityDependency(f.binding, f.read);
  expect(r).toMatchObject({ identityConfigurationVerified: true, designatedSyntheticSubjectsVerified: true, observations: 10,
    identityDependenciesVerified: false, databaseIdentityAuthorityVerified: false, retentionServiceIdentityVerified: false,
    physicalLoginVerified: false, liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false });
  expect(f.calls).toHaveLength(20); expect(r.observationSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.personBindingsSha256).toBe(inventorySha(inventoryCanonical({ consumer: '55555555-5555-4555-8555-555555555555',
    foreignConsumer: '66666666-5555-4555-8555-555555555555', workforce: '77777777-5555-4555-8555-555555555555' })));
  expect(f.calls.slice(0, 10)).toEqual(f.calls.slice(10));
  expect(f.calls.filter(c => c[1] === 'admin-get-user').map(c => c[2].Username)).toEqual([...Object.values(subjects), ...Object.values(subjects)]);
  expect(JSON.stringify(r)).not.toContain(subjects.consumer); expect(JSON.stringify(r)).not.toContain(org);
});
it('refuses malformed, shared or cross-region identity bindings before AWS', async () => {
  const changes: Array<(b: InventoryIdentityDependency) => void> = [
    b => { b.organizationId = 'invalid'; }, b => { b.subjects.foreignConsumer = b.subjects.consumer; },
    b => { b.subjects.workforce = 'not-a-subject'; }, b => { b.identity.workforceIssuer = b.identity.consumerIssuer; },
    b => { b.identity.workforceAudience = b.identity.consumerAudience; }, b => { b.identity.consumerAudience = 'invalid'; },
    b => { b.identity.consumerIssuer = b.identity.consumerIssuer.replace('us-east-2', 'us-east-1'); },
    b => { obj(b).approved = true; }, b => { obj(b.identity).token = 'supplied'; }, b => { obj(b.subjects).retentionService = 'invented'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.binding);
    await expect(observeInventoryIdentityDependency(f.binding, f.read)).rejects.toThrow('identity_dependency_binding_refused');
    expect(f.calls).toHaveLength(0);
  }
});
it('refuses independent pool, client, MFA and synthetic identity failures, including absent write permissions', async () => {
  await observeInventoryIdentityDependency(fixture().binding, fixture().read);
  const changes: Array<[string, (v: Row) => void]> = [];
  const pool = (f: (v: Row) => void) => changes.push([`describe-user-pool/${poolId(true)}`, v => f(obj(v.UserPool))]);
  const client = (f: (v: Row) => void) => changes.push([`describe-user-pool-client/${poolId(false)}`, v => f(obj(v.UserPoolClient))]);
  const user = (f: (v: Row) => void) => changes.push([`admin-get-user/${subjects.workforce}`, f]);
  for (const [name, value] of Object.entries({ Id: poolId(false), Arn: 'foreign-account', DeletionProtection: 'INACTIVE', MfaConfiguration: 'OPTIONAL',
    Status: 'Disabled', UsernameConfiguration: { CaseSensitive: true }, UsernameAttributes: ['phone_number'], AutoVerifiedAttributes: [],
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] }, LambdaConfig: { PreTokenGeneration: 'foreign-hook' },
    DeviceConfiguration: { ChallengeRequiredOnNewDevice: true }, UserPoolAddOns: { AdvancedSecurityMode: 'AUDIT' } })) pool(v => { v[name] = value; });
  pool(v => { obj(v.UserPoolTags).DataClassification = 'production'; });
  pool(v => { obj(v.UserPoolTags).ContainsPhi = 'true'; });
  pool(v => { obj(obj(v.Policies).PasswordPolicy).MinimumLength = 10; });
  pool(v => { delete obj(v.Policies).SignInPolicy; });
  for (const factors of [[], ['EMAIL_OTP'], ['PASSWORD', 'SMS_OTP'], ['PASSWORD', 'WEB_AUTHN'], ['PASSWORD', 'PASSWORD']])
    pool(v => { obj(v.Policies).SignInPolicy = { AllowedFirstAuthFactors: factors }; });
  pool(v => { obj(v.Policies).UnknownPolicy = {}; });
  pool(v => { obj(obj(v.Policies).SignInPolicy).Unknown = true; });
  pool(v => { (v.SchemaAttributes as Row[])[2].Mutable = true; });
  pool(v => { (v.SchemaAttributes as Row[])[0].DeveloperOnlyAttribute = true; });
  pool(v => { (v.SchemaAttributes as Row[])[0].StringAttributeConstraints = { MinLength: '1', MaxLength: '99' }; });
  pool(v => { (v.SchemaAttributes as Row[]).pop(); });
  pool(v => { (v.SchemaAttributes as Row[]).push((v.SchemaAttributes as Row[])[0]); });
  pool(v => { (v.SchemaAttributes as Row[]).push({ Name: 'custom:unreviewed' }); });
  for (const [name, value] of Object.entries({ UserPoolId: poolId(true), ClientId: 'foreign', HasClientSecret: true, PreventUserExistenceErrors: 'LEGACY',
    EnableTokenRevocation: false, AccessTokenValidity: 60, RefreshTokenValidity: 30, TokenValidityUnits: { RefreshToken: 'days' },
    ExplicitAuthFlows: ['ALLOW_CUSTOM_AUTH'], ReadAttributes: [], WriteAttributes: ['email', 'custom:person_id'], AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['implicit'], CallbackURLs: ['https://unreviewed.test'], SupportedIdentityProviders: ['Google'],
    RefreshTokenRotation: { Feature: 'ENABLED' }, EnablePropagateAdditionalUserContextData: true, ClientSecret: 'fictional-secret' })) client(v => { v[name] = value; });
  client(v => { delete v.WriteAttributes; });
  client(v => { (v.ExplicitAuthFlows as string[]).push('ALLOW_CUSTOM_AUTH'); });
  client(v => { (v.ReadAttributes as string[]).push((v.ReadAttributes as string[])[0]); });
  changes.push([`get-user-pool-mfa-config/${poolId(true)}`, v => { v.MfaConfiguration = 'OFF'; }]);
  changes.push([`get-user-pool-mfa-config/${poolId(true)}`, v => { v.SoftwareTokenMfaConfiguration = { Enabled: false }; }]);
  changes.push([`get-user-pool-mfa-config/${poolId(true)}`, v => { v.SmsMfaConfiguration = { SmsAuthenticationMessage: 'unreviewed' }; }]);
  user(v => { v.Enabled = false; }); user(v => { v.UserStatus = 'FORCE_CHANGE_PASSWORD'; });
  user(v => { v.UserMFASettingList = []; }); user(v => { v.PreferredMfaSetting = 'SMS_MFA'; });
  for (const [name, value] of Object.entries({ sub: subjects.consumer, email_verified: 'false', 'custom:person_id': 'invalid',
    'custom:organization_id': '99999999-9999-4999-8999-999999999999', 'custom:synthetic_attested': 'false' })) user(v => {
      (v.UserAttributes as Row[]).find(a => a.Name === name)!.Value = value;
    });
  user(v => { (v.UserAttributes as Row[]).push({ Name: 'custom:production_bound', Value: 'true' }); });
  user(v => { (v.UserAttributes as Row[]).push({ Name: 'email', Value: 'must-not-emit@example.test' }); });
  user(v => { (v.UserAttributes as Row[]).push((v.UserAttributes as Row[])[0]); });
  changes.push(['sts', v => { v.Arn = 'arn:aws:iam::588966314750:root'; }]);
  changes.push(['sts', v => { v.Account = '173535830222'; }]);
  for (const [key, change] of changes) {
    const f = fixture(), before = inventoryCanonical(f.responses[key]); change(obj(f.responses[key]));
    expect(inventoryCanonical(f.responses[key]), key).not.toBe(before);
    await expect(observeInventoryIdentityDependency(f.binding, f.read), key).rejects.toThrow();
  }
});
it('observes configuration before subjects exist, without claiming accounts, database mappings or a physical MFA login', async () => {
  const f = fixture();
  for (const subject of Object.values(subjects)) delete f.responses[`admin-get-user/${subject}`];
  const r = await observeInventoryIdentityConfiguration(f.binding.identity, f.read);
  expect(r).toMatchObject({ contract: 'inventory-qualification-identity-configuration/1', observations: 7,
    identityConfigurationVerified: true, designatedSyntheticSubjectsVerified: false, databaseIdentityAuthorityVerified: false,
    retentionServiceIdentityVerified: false, physicalLoginVerified: false, identityDependenciesVerified: false,
    liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false });
  expect(f.calls).toHaveLength(14); expect(f.calls.slice(0, 7)).toEqual(f.calls.slice(7));
  expect(f.calls.some(c => c[1] === 'admin-get-user')).toBe(false);
  expect(r.observationSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('configuration-only inspection refuses unsafe pool settings, root, binding substitutions and drift', async () => {
  const f = fixture();
  await expect(observeInventoryIdentityConfiguration({ ...f.binding.identity, consumerAudience: 'invalid' }, f.read))
    .rejects.toThrow('identity_dependency_binding_refused');
  expect(f.calls).toHaveLength(0);
  for (const factors of [undefined, [], ['PASSWORD', 'EMAIL_OTP']]) {
    const g = fixture(), p = obj(obj(g.responses[`describe-user-pool/${poolId(false)}`]).UserPool);
    obj(p.Policies).SignInPolicy = factors === undefined ? undefined : { AllowedFirstAuthFactors: factors };
    await expect(observeInventoryIdentityConfiguration(g.binding.identity, g.read)).rejects.toThrow();
    expect(g.calls.some(c => c[1] === 'admin-get-user')).toBe(false);
  }
  const root = fixture(); obj(root.responses.sts).Arn = 'arn:aws:iam::588966314750:root';
  await expect(observeInventoryIdentityConfiguration(root.binding.identity, root.read)).rejects.toThrow('identity_dependency_principal_refused');
  const drift = fixture(); let n = 0;
  await expect(observeInventoryIdentityConfiguration(drift.binding.identity, async (s, o, p) => {
    const value = await drift.read(s, o, p); if (++n === 9) obj(obj(value).UserPool).DeletionProtection = 'INACTIVE'; return value;
  })).rejects.toThrow('identity_dependency_refused');
});
it('refuses person aliasing even when subjects are distinct', async () => {
  const f = fixture();
  const first = obj(f.responses[`admin-get-user/${subjects.consumer}`]).UserAttributes as Row[];
  const second = obj(f.responses[`admin-get-user/${subjects.foreignConsumer}`]).UserAttributes as Row[];
  second.find(a => a.Name === 'custom:person_id')!.Value = first.find(a => a.Name === 'custom:person_id')!.Value;
  await expect(observeInventoryIdentityDependency(f.binding, f.read)).rejects.toThrow('identity_dependency_person_isolation_refused');
});
it('refuses failures and drift without retry, including a subject disabled during inspection', async () => {
  const f = fixture();
  await expect(observeInventoryIdentityDependency(f.binding, async () => { throw Error('fictional_denied'); })).rejects.toThrow('fictional_denied');
  let n = 0;
  await expect(observeInventoryIdentityDependency(f.binding, async (s, o, p) => {
    const v = await f.read(s, o, p); if (++n === 15) obj(v).Enabled = false; return v;
  })).rejects.toThrow('identity_dependency_refused');
});
it('pins read-only transport, finite output and non-secret projections; arbitrary usernames/scans/auth/writes are refused', async () => {
  const calls: Array<{ args: string[]; options: unknown }> = [];
  const execute = ((_file: string, args: string[], options: unknown) => { calls.push({ args, options }); return '{}'; }) as typeof execFileSync;
  const read = inventoryIdentityReader(execute);
  for (const [o, p] of [
    ['describe-user-pool', { UserPoolId: poolId(false) }], ['describe-user-pool-client', { UserPoolId: poolId(false), ClientId: audience(false) }],
    ['get-user-pool-mfa-config', { UserPoolId: poolId(true) }], ['admin-get-user', { UserPoolId: poolId(true), Username: subjects.workforce }],
  ] as const) await read('cognito-idp', o, p);
  for (const c of calls) {
    expect(c.args).toContain('--query'); expect(c.args).toContain('ai-synthetic-member'); expect(c.args).toContain('us-east-2');
    expect(c.options).toMatchObject({ timeout: 30000, windowsHide: true, maxBuffer: 1048576, env: { AWS_MAX_ATTEMPTS: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' } });
  }
  expect(calls[1].args.join(' ')).toContain('HasClientSecret:ClientSecret != `null`');
  const userQuery = calls[3].args[calls[3].args.indexOf('--query') + 1];
  expect(userQuery).not.toContain('Username:'); expect(userQuery).not.toContain('Name == `email`'); expect(userQuery).not.toContain('phone_number');
  for (const o of ['list-users', 'admin-create-user', 'admin-initiate-auth', 'initiate-auth', 'admin-set-user-password', 'update-user-pool'])
    await expect(read('cognito-idp', o, { UserPoolId: poolId(false) })).rejects.toThrow('identity_read_operation_refused');
  for (const p of [{ UserPoolId: poolId(true), Username: 'email@example.test' }, { UserPoolId: poolId(true), Username: '--profile=production' },
    { UserPoolId: 'us-east-1_foreign', Username: subjects.workforce }, { UserPoolId: poolId(true), Username: subjects.workforce, Token: 'supplied' }])
    await expect(read('cognito-idp', 'admin-get-user', p as Record<string, string | string[]>)).rejects.toThrow('identity_read_operation_refused');
  expect(calls).toHaveLength(4);
  for (const output of ['', 'not-json']) await expect(inventoryIdentityReader((() => output) as unknown as typeof execFileSync)
    ('cognito-idp', 'describe-user-pool', { UserPoolId: poolId(true) })).rejects.toThrow('identity_aws_read_failed');
  const failed = (() => { throw Object.assign(Error('private'), { status: 254, stderr: 'UserNotFoundException' }); }) as typeof execFileSync;
  await expect(inventoryIdentityReader(failed)('cognito-idp', 'admin-get-user', { UserPoolId: poolId(true), Username: subjects.workforce })).rejects.toThrow('identity_aws_read_failed');
});
