import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AdminGetUserCommand, DescribeUserPoolCommand } from '@aws-sdk/client-cognito-identity-provider';
import { createPlatformOperatorAuthenticator, PLATFORM_OPERATOR_SIGN_IN_RELEASE, platformOperatorTarget } from './platform-operator-authenticator';

/**
 * The platform operator's separate, MFA-protected sign-in. Fictional pools, clients and subjects; the JWT verifier and
 * the Cognito reads are substituted at their boundary. No operator pool exists; this is source behaviour only.
 */
const OPERATOR_POOL = 'us-east-2_OpErAtOr1', OPERATOR_CLIENT = 'o'.repeat(26);
const WORKFORCE_POOL = 'us-east-2_ueGlFRbNB', WORKFORCE_CLIENT = '4s7jgr4o8sqdq7cvo9gmq96e2h';
const target = { account: '588966314750', operatorPoolId: OPERATOR_POOL, operatorClientId: OPERATOR_CLIENT,
  otherPoolIds: [WORKFORCE_POOL, 'us-east-2_CoNsUmEr1'], otherClientIds: [WORKFORCE_CLIENT, 'c'.repeat(26)] };
const NOW = Date.parse('2026-10-16T01:00:00Z');
const operator = randomUUID();
const token = 'aaa.bbb.ccc';
const claims = (over: Record<string, unknown> = {}) => ({ iss: `https://cognito-idp.us-east-2.amazonaws.com/${OPERATOR_POOL}`, aud: OPERATOR_CLIENT,
  token_use: 'id', sub: operator, exp: NOW / 1000 + 600, iat: NOW / 1000 - 60, auth_time: NOW / 1000 - 120, ...over });
function setup(options: { claims?: Record<string, unknown>; pool?: Record<string, unknown>; user?: Record<string, unknown>; release?: 'blocked' | 'qualification' } = {}) {
  const verify = vi.fn(async () => claims(options.claims));
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeUserPoolCommand) return { UserPool: { Id: OPERATOR_POOL, Arn: `arn:aws:cognito-idp:us-east-2:588966314750:userpool/${OPERATOR_POOL}`,
      MfaConfiguration: 'ON', LastModifiedDate: new Date(NOW - 86_400_000), ...options.pool } };
    if (command instanceof AdminGetUserCommand) return { Enabled: true, UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
      PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA', UserLastModifiedDate: new Date(NOW - 86_400_000),
      UserAttributes: [{ Name: 'sub', Value: operator }, { Name: 'email_verified', Value: 'true' }], ...options.user };
    throw new Error('unexpected command');
  });
  const authenticate = createPlatformOperatorAuthenticator({ target, jwt: { verify }, cognito: { send }, release: options.release ?? 'qualification', now: () => NOW });
  return { authenticate, verify, send };
}

describe('the platform operator sign-in', () => {
  it('ships blocked: refused before any token is read', async () => {
    expect(PLATFORM_OPERATOR_SIGN_IN_RELEASE).toBe('blocked');
    const f = setup({ release: 'blocked' });
    await expect(f.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'not_released' });
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('is a separate login: a configuration that shares the workforce or consumer pool or client is refused', () => {
    expect(platformOperatorTarget.safeParse({ ...target, operatorPoolId: WORKFORCE_POOL }).success).toBe(false);
    expect(platformOperatorTarget.safeParse({ ...target, operatorClientId: WORKFORCE_CLIENT }).success).toBe(false);
  });

  it('admits a fresh, TOTP-protected sign-in from the operator pool, and answers only its subject', async () => {
    const f = setup();
    await expect(f.authenticate(`Bearer ${token}`)).resolves.toBe(operator);
    expect(f.verify).toHaveBeenCalledWith(token);
  });

  it.each([
    ['a workforce token, even for a registered subject', { claims: { iss: `https://cognito-idp.us-east-2.amazonaws.com/${WORKFORCE_POOL}`, aud: WORKFORCE_CLIENT } }],
    ['an access token instead of the operator ID token', { claims: { token_use: 'access' } }],
    ['another client of the operator pool', { claims: { aud: 'x'.repeat(26) } }],
    ['a sign-in older than 15 minutes', { claims: { auth_time: NOW / 1000 - 16 * 60, iat: NOW / 1000 - 60 } }],
    ['an expired token', { claims: { exp: NOW / 1000 - 1 } }],
    ['a pool where MFA is only optional', { pool: { MfaConfiguration: 'OPTIONAL' } }],
    ['a pool where MFA is off', { pool: { MfaConfiguration: 'OFF' } }],
    ['an account whose only factor is SMS', { user: { UserMFASettingList: ['SMS_MFA'], PreferredMfaSetting: 'SMS_MFA' } }],
    ['an account that prefers SMS over its TOTP', { user: { UserMFASettingList: ['SOFTWARE_TOKEN_MFA', 'SMS_MFA'], PreferredMfaSetting: 'SMS_MFA' } }],
    ['an account with no MFA at all', { user: { UserMFASettingList: [], PreferredMfaSetting: undefined } }],
    ['a disabled account', { user: { Enabled: false } }],
    ['an account changed after the sign-in (an MFA change, say)', { user: { UserLastModifiedDate: new Date(NOW - 30_000) } }],
    ['an unconfirmed address', { user: { UserAttributes: [{ Name: 'sub', Value: operator }, { Name: 'email_verified', Value: 'false' }] } }],
    ['a federated account', { user: { UserAttributes: [{ Name: 'sub', Value: operator }, { Name: 'email_verified', Value: 'true' }, { Name: 'identities', Value: '[]' }] } }],
  ])('refuses %s', async (_label, options) => {
    const f = setup(options);
    await expect(f.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ code: 'operator_refused' });
  });

  it('refuses a malformed authorization header without verifying anything', async () => {
    const f = setup();
    for (const header of ['', token, `Basic ${token}`, `Bearer ${'a'.repeat(20000)}.b.c`]) {
      await expect(f.authenticate(header)).rejects.toMatchObject({ code: 'operator_refused' });
    }
    expect(f.verify).not.toHaveBeenCalled();
  });
});
