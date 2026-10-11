import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { FetchError } from 'aws-jwt-verify/error';
import { createTelehealthQualificationAuthenticationSource, TelehealthAuthenticationError,
  type TelehealthAuthenticationTarget } from './telehealth-qualification-authentication';

const now = Math.floor(Date.now() / 1000) * 1000, earlier = new Date(now - 60_000);
const org = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222',
  second = '33333333-3333-4333-8333-333333333333', workforcePerson = '44444444-4444-4444-8444-444444444444';
const target: TelehealthAuthenticationTarget = { contract: 'telehealth-qualification-authentication/1', account: '588966314750',
  region: 'us-east-2', phiAllowed: false, activation: 'blocked', organizationId: org,
  consumer: { poolId: 'us-east-2_FictionalConsumer', clientId: 'c'.repeat(26), identities: [
    { subject: 'fictional-consumer', personId: person }, { subject: 'fictional-consumer-2', personId: second }] },
  workforce: { poolId: 'us-east-2_FictionalWorkforce', clientId: 'w'.repeat(26), identities: [{ subject: 'fictional-workforce', personId: workforcePerson }] } };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const jwks = { keys: [{ ...jwk, kty: 'RSA', kid: 'FICTIONAL_KEY', alg: 'RS256', use: 'sig' }] };
type Row = Record<string, unknown>;
const commandName = (command: unknown) => (command as { constructor: { name: string } }).constructor.name;
function rig(workforce = true, supplied: unknown = target) {
  const pool = workforce ? 'workforce' : 'consumer', configuration = target[pool], identity = configuration.identities[0];
  const claims: Row = { iss: `https://cognito-idp.us-east-2.amazonaws.com/${configuration.poolId}`, aud: configuration.clientId,
    token_use: 'id', sub: identity.subject, email: 'fictional@example.invalid', email_verified: true,
    'custom:person_id': identity.personId, 'custom:organization_id': org, 'custom:production_bound': 'true',
    exp: now / 1000 + 300, iat: now / 1000 - 10, auth_time: now / 1000 - 10 };
  const replies: Record<string, Row> = {
    DescribeUserPoolCommand: { UserPool: { Id: configuration.poolId, Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${configuration.poolId}`,
      MfaConfiguration: 'ON', LastModifiedDate: earlier } },
    DescribeUserPoolClientCommand: { UserPoolClient: { UserPoolId: configuration.poolId, ClientId: configuration.clientId,
      SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'], LastModifiedDate: earlier } },
    AdminGetUserCommand: { Enabled: true, UserStatus: 'CONFIRMED', UserLastModifiedDate: earlier, UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
      PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserAttributes: Object.entries({ sub: identity.subject, email: claims.email,
        email_verified: 'true', 'custom:person_id': identity.personId, 'custom:organization_id': org, 'custom:production_bound': 'true' }).map(([Name, Value]) => ({ Name, Value })) },
    GetUserPoolMfaConfigCommand: { MfaConfiguration: 'ON', SoftwareTokenMfaConfiguration: { Enabled: true } },
  };
  const cognito = { send: vi.fn(async (command: unknown, options: { abortSignal: AbortSignal }) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    return structuredClone(replies[commandName(command)]);
  }) };
  const jwt = CognitoJwtVerifier.create([target.consumer, target.workforce].map(p => ({ userPoolId: p.poolId, tokenUse: 'id' as const, clientId: p.clientId })));
  jwt.cacheJwks(jwks, target.consumer.poolId); jwt.cacheJwks(jwks, target.workforce.poolId);
  const signedEvent = (change: Row = {}) => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const content = `${encode({ kid: 'FICTIONAL_KEY', alg: 'RS256', typ: 'JWT' })}.${encode({ ...claims, ...change })}`;
    return { headers: { authorization: `Bearer ${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}` } };
  };
  const clock = vi.fn(() => now), source = createTelehealthQualificationAuthenticationSource({ target: supplied, cognito, jwt, now: clock });
  return { pool, claims, replies, cognito, jwt, signedEvent, clock, source,
    run: (change: Row = {}) => source.authenticate(signedEvent(change), pool) };
}
afterEach(() => vi.restoreAllMocks());

it('rejects a backwards clock between later Cognito reads even when it remains after the original start', async () => {
  const r = rig();
  r.cognito.send.mockImplementationOnce(async () => { r.clock.mockReturnValue(now + 1_000); return structuredClone(r.replies.DescribeUserPoolCommand); });
  r.cognito.send.mockImplementationOnce(async () => { r.clock.mockReturnValue(now + 500); return structuredClone(r.replies.DescribeUserPoolClientCommand); });
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' }); expect(r.cognito.send).toHaveBeenCalledTimes(2);
});

it('verifies a real locally signed token and current workforce MFA before issuing a minimal identity observation', async () => {
  const r = rig(), observation = await r.run();
  expect(observation).toMatchObject({ identityPool: 'workforce', identitySubject: 'fictional-workforce', actorPersonId: workforcePerson,
    organizationId: org, email: 'fictional@example.invalid', authenticatedAt: now - 10_000, tokenExpiresAt: now + 300_000, observedAt: now });
  expect(observation.tokenSha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.isFrozen(observation)).toBe(true);
  expect(r.source.isObserved(observation)).toBe(true); expect(r.source.isObserved({ ...observation })).toBe(false);
  expect(r.cognito.send.mock.calls.map(([command]) => commandName(command))).toEqual([
    'DescribeUserPoolCommand', 'DescribeUserPoolClientCommand', 'AdminGetUserCommand', 'GetUserPoolMfaConfigCommand']);
  expect(r.cognito.send.mock.calls[2][0]).toMatchObject({ input: { UserPoolId: target.workforce.poolId, Username: 'fictional-workforce' } });
  expect(JSON.stringify(observation)).not.toContain('Bearer'); expect(observation).not.toHaveProperty('claims');
});
it('consumer observations never inherit practitioner MFA or query credentials/providers', async () => {
  const r = rig(false); delete r.replies.AdminGetUserCommand.UserMFASettingList;
  delete (r.replies.DescribeUserPoolCommand.UserPool as Row).MfaConfiguration;
  expect(await r.run()).toMatchObject({ identityPool: 'consumer', actorPersonId: person });
  expect(r.cognito.send.mock.calls.map(([command]) => commandName(command))).toEqual([
    'DescribeUserPoolCommand', 'DescribeUserPoolClientCommand', 'AdminGetUserCommand']);
});
it('does not use fabricated authorizer or body claims as identity authority', async () => {
  const r = rig(false), event = { ...r.signedEvent(), requestContext: { authorizer: { jwt: { claims: { sub: 'forged', 'custom:person_id': workforcePerson } } } },
    body: JSON.stringify({ identityPool: 'workforce', organizationId: second }) };
  expect(await r.source.authenticate(event, 'consumer')).toMatchObject({ identitySubject: 'fictional-consumer', actorPersonId: person, organizationId: org });
});
it.each([{ headers: {} }, { headers: { authorization: 'Bearer unsigned.token.value' } },
  { headers: { authorization: 'Bearer bad' } }, { headers: { authorization: 'Bearer a.b.c', Authorization: 'Bearer a.b.c' } },
  { headers: { authorization: 'Bearer ' + 'x'.repeat(16_384) } }])('refuses malformed/unverified authorization before Cognito reads %j', async event => {
  const r = rig(); await expect(r.source.authenticate(event, 'workforce')).rejects.toMatchObject({ category: 'reauth_required' });
  expect(r.cognito.send).not.toHaveBeenCalled();
});
it('signature tampering cannot substitute another designated owner', async () => {
  const r = rig(false), event = r.signedEvent(), parts = event.headers.authorization.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...r.claims, sub: 'fictional-consumer-2', 'custom:person_id': second })).toString('base64url');
  await expect(r.source.authenticate({ headers: { authorization: parts.join('.') } }, 'consumer')).rejects.toMatchObject({ category: 'reauth_required' });
  expect(r.cognito.send).not.toHaveBeenCalled();
});
it.each([{ token_use: 'access' }, { iss: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Other' }, { aud: 'wrong' },
  { sub: 'fictional-other' }, { email_verified: false }, { 'custom:person_id': second }, { 'custom:organization_id': second },
  { 'custom:production_bound': 'false' }, { 'custom:synthetic_attested': 'true' }, { auth_time: now / 1000 - 901 },
  { auth_time: now / 1000 + 1 }, { iat: now / 1000 + 1 }, { exp: now / 1000 }, { exp: '9999999999' },
  { iat: now / 1000 - 20 }, { auth_time: undefined }])('refuses signed but ineligible claims %j', async claims => {
  const r = rig(); await expect(r.run(claims)).rejects.toMatchObject({ category: 'reauth_required' });
  expect(r.cognito.send).not.toHaveBeenCalled();
});
it.each(['disabled', 'unconfirmed', 'changed-user', 'other-person', 'other-clinic', 'unverified-email', 'synthetic-claim', 'federated-user'])
('requires current user authority, not only old signed claims: %s', async change => {
  const r = rig(), user = r.replies.AdminGetUserCommand, attributes = user.UserAttributes as { Name: string; Value: unknown }[];
  if (change === 'disabled') user.Enabled = false;
  if (change === 'unconfirmed') user.UserStatus = 'UNCONFIRMED';
  if (change === 'changed-user') user.UserLastModifiedDate = new Date(now);
  if (change === 'other-person') attributes.find(a => a.Name === 'custom:person_id')!.Value = second;
  if (change === 'other-clinic') attributes.find(a => a.Name === 'custom:organization_id')!.Value = second;
  if (change === 'unverified-email') attributes.find(a => a.Name === 'email_verified')!.Value = 'false';
  if (change === 'synthetic-claim') attributes.push({ Name: 'custom:synthetic_attested', Value: 'true' });
  if (change === 'federated-user') attributes.push({ Name: 'identities', Value: 'fictional' });
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' });
});
it.each(['mfa-off', 'remember-device', 'external-login', 'custom-flow', 'passwordless', 'refresh-only', 'no-totp', 'sms-user',
  'preferred-sms', 'pool-changed', 'client-changed', 'policy-passkey', 'totp-disabled', 'sms-enabled', 'email-enabled', 'webauthn-enabled'])
('refuses a workforce MFA bypass/policy change: %s', async change => {
  const r = rig(), pool = r.replies.DescribeUserPoolCommand.UserPool as Row,
    client = r.replies.DescribeUserPoolClientCommand.UserPoolClient as Row, user = r.replies.AdminGetUserCommand, mfa = r.replies.GetUserPoolMfaConfigCommand;
  if (change === 'mfa-off') pool.MfaConfiguration = 'OFF';
  if (change === 'remember-device') pool.DeviceConfiguration = {};
  if (change === 'external-login') client.SupportedIdentityProviders = ['COGNITO', 'Google'];
  if (change === 'custom-flow') client.ExplicitAuthFlows = ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_CUSTOM_AUTH'];
  if (change === 'passwordless') client.ExplicitAuthFlows = ['ALLOW_USER_AUTH'];
  if (change === 'refresh-only') client.ExplicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
  if (change === 'no-totp') user.UserMFASettingList = [];
  if (change === 'sms-user') user.UserMFASettingList = ['SOFTWARE_TOKEN_MFA', 'SMS_MFA'];
  if (change === 'preferred-sms') user.PreferredMfaSetting = 'SMS_MFA';
  if (change === 'pool-changed') pool.LastModifiedDate = new Date(now);
  if (change === 'client-changed') client.LastModifiedDate = new Date(now);
  if (change === 'policy-passkey') pool.Policies = { SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD', 'WEB_AUTHN'] } };
  if (change === 'totp-disabled') mfa.SoftwareTokenMfaConfiguration = { Enabled: false };
  if (change === 'sms-enabled') mfa.SmsMfaConfiguration = {};
  if (change === 'email-enabled') mfa.EmailMfaConfiguration = {};
  if (change === 'webauthn-enabled') mfa.WebAuthnConfiguration = {};
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' });
});
it.each(['pool-account', 'pool-id', 'client-id', 'duplicate-attribute', 'malformed-user', 'unreadable-change-date'])
('refuses unreadable or wrongly bound live resources: %s', async change => {
  const r = rig(), pool = r.replies.DescribeUserPoolCommand.UserPool as Row, client = r.replies.DescribeUserPoolClientCommand.UserPoolClient as Row;
  if (change === 'pool-account') pool.Arn = String(pool.Arn).replace('588966314750', '173535830222');
  if (change === 'pool-id') pool.Id = 'us-east-2_Other';
  if (change === 'client-id') client.ClientId = target.consumer.clientId;
  if (change === 'duplicate-attribute') (r.replies.AdminGetUserCommand.UserAttributes as unknown[]).push({ Name: 'sub', Value: 'duplicate' });
  if (change === 'malformed-user') r.replies.AdminGetUserCommand.UserAttributes = {};
  if (change === 'unreadable-change-date') r.replies.AdminGetUserCommand.UserLastModifiedDate = '2026-10-11';
  await expect(r.run()).rejects.toMatchObject({ category: 'service_unavailable' });
});
it('clock/token expiration during live observation cannot mint a late identity', async () => {
  const r = rig(); r.cognito.send.mockImplementation(async command => {
    r.clock.mockReturnValue(now + 300_000); return structuredClone(r.replies[commandName(command)]);
  });
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' }); expect(r.cognito.send).toHaveBeenCalledOnce();
});
it('deadline expiry prevents late verification from starting any Cognito read', async () => {
  const r = rig(), controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const verify = vi.spyOn(r.jwt, 'verify').mockImplementation(async () => { controller.abort(); return r.claims as never; });
  await expect(r.run()).rejects.toMatchObject({ category: 'service_unavailable' }); expect(verify).toHaveBeenCalledOnce(); expect(r.cognito.send).not.toHaveBeenCalled();
});
it('JWKS/reader outages remain unavailable and never echo credentials', async () => {
  const r = rig(); vi.spyOn(r.jwt, 'verify').mockRejectedValueOnce(new FetchError('https://fictional.invalid', 'secret token patient data'));
  const failure = await r.run().catch(e => e); expect(failure).toBeInstanceOf(TelehealthAuthenticationError);
  expect(failure).toMatchObject({ category: 'service_unavailable', message: 'service_unavailable' }); expect(r.cognito.send).not.toHaveBeenCalled();
  r.cognito.send.mockRejectedValueOnce(Error('secret token patient data'));
  await expect(r.run()).rejects.toMatchObject({ category: 'service_unavailable', message: 'service_unavailable' });
});
it('takes a defensive target copy and keeps observations private to their source instance', async () => {
  const supplied = structuredClone(target), r = rig(true, supplied); supplied.organizationId = second;
  const observation = await r.run(); expect(observation.organizationId).toBe(org);
  const other = rig(); expect(other.source.isObserved(observation)).toBe(false); expect(other.source.isObserved(null)).toBe(false);
});
it('simultaneous consumer and practitioner authentication never shares a process-global current actor', async () => {
  const consumer = rig(false), workforce = rig();
  const source = createTelehealthQualificationAuthenticationSource({ target, jwt: workforce.jwt, now: () => now,
    cognito: { send: (command, options) => ((command as { input: { UserPoolId: string } }).input.UserPoolId === target.consumer.poolId
      ? consumer.cognito : workforce.cognito).send(command, options) } });
  const observations = await Promise.all([source.authenticate(consumer.signedEvent(), 'consumer'), source.authenticate(workforce.signedEvent(), 'workforce')]);
  expect(observations.map(r => [r.identityPool, r.identitySubject, r.actorPersonId])).toEqual([
    ['consumer', 'fictional-consumer', person], ['workforce', 'fictional-workforce', workforcePerson]]);
  expect(observations.every(source.isObserved)).toBe(true);
});
it('a token which expires during the last MFA read cannot return an observation', async () => {
  const r = rig(); r.cognito.send.mockImplementation(async command => {
    if (commandName(command) === 'GetUserPoolMfaConfigCommand') r.clock.mockReturnValue(now + 300_000);
    return structuredClone(r.replies[commandName(command)]);
  });
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' }); expect(r.cognito.send).toHaveBeenCalledTimes(4);
});
it('a late Cognito read after the shared deadline cannot start another read or return identity', async () => {
  const r = rig(), controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  r.cognito.send.mockImplementation(async command => { controller.abort(); return structuredClone(r.replies[commandName(command)]); });
  await expect(r.run()).rejects.toMatchObject({ category: 'service_unavailable' }); expect(r.cognito.send).toHaveBeenCalledOnce();
});
it('a backwards clock change during observation refuses instead of extending the authentication window', async () => {
  const r = rig(); r.cognito.send.mockImplementation(async command => {
    r.clock.mockReturnValue(now - 1); return structuredClone(r.replies[commandName(command)]);
  });
  await expect(r.run()).rejects.toMatchObject({ category: 'reauth_required' }); expect(r.cognito.send).toHaveBeenCalledOnce();
});
it.each([{ phiAllowed: true }, { activation: 'approved' }, { account: '173535830222' }, { region: 'us-west-2' },
  { providerSecretArn: 'not-an-authentication-input' }, { consumer: target.workforce },
  { workforce: { ...target.workforce, identities: [{ subject: 'fictional-consumer', personId: workforcePerson }] } },
  { workforce: { ...target.workforce, identities: [{ subject: 'fictional-workforce', personId: person }] } }])
('refuses configuration that broadens authority %j', async change => {
  expect(() => rig(true, { ...target, ...change })).toThrow();
});
