import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { createCognitoCurrentWorkforceApplicant } from './aws-workforce-applicant-identity';

const subject = randomUUID();
const pool = 'us-east-2_ueGlFRbNB';
const confirmed = () => ({
  Enabled: true, UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
  UserAttributes: [
    { Name: 'sub', Value: subject },
    { Name: 'email', Value: 'Fictional.Practitioner@example.invalid' },
    { Name: 'email_verified', Value: 'true' },
  ],
});

describe('read-only current workforce applicant identity', () => {
  it('accepts the real Cognito client interface without issuing a request', () => {
    const client = new CognitoIdentityProviderClient({ region: 'us-east-2' });
    expect(createCognitoCurrentWorkforceApplicant(client)).toBeTypeOf('function');
    client.destroy();
  });

  it('reads the exact fictional pool and subject with a bounded request, then maps current MFA settings', async () => {
    const send = vi.fn(async () => confirmed());
    const read = createCognitoCurrentWorkforceApplicant({ send });
    expect(await read(subject)).toEqual({ subject,email: 'fictional.practitioner@example.invalid',
      emailVerified: true,enabled: true,mfaMethods: ['SOFTWARE_TOKEN_MFA'] });
    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0] as unknown as [AdminGetUserCommand,{abortSignal: AbortSignal}];
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    expect(command.input).toEqual({ UserPoolId: pool,Username: subject });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['missing subject', (user: ReturnType<typeof confirmed>) => { user.UserAttributes = user.UserAttributes.filter(a => a.Name !== 'sub'); }],
    ['changed subject', (user: ReturnType<typeof confirmed>) => { user.UserAttributes[0].Value = randomUUID(); }],
    ['duplicate email', (user: ReturnType<typeof confirmed>) => { user.UserAttributes.push({ Name: 'email',Value: 'other@example.invalid' }); }],
    ['unconfirmed email', (user: ReturnType<typeof confirmed>) => { user.UserAttributes[2].Value = 'false'; }],
    ['disabled user', (user: ReturnType<typeof confirmed>) => { user.Enabled = false; }],
    ['unconfirmed user', (user: ReturnType<typeof confirmed>) => { user.UserStatus = 'UNCONFIRMED'; }],
    ['missing MFA', (user: ReturnType<typeof confirmed>) => { user.UserMFASettingList = []; }],
  ])('refuses %s without returning an applicant', async (_name, change) => {
    const user = confirmed(); change(user);
    const read = createCognitoCurrentWorkforceApplicant({ send: vi.fn(async () => user) });
    expect(await read(subject)).toBeNull();
  });

  it('returns null for a missing user but propagates an outage for the handler to report as unavailable', async () => {
    const missing = createCognitoCurrentWorkforceApplicant({ send: vi.fn(async () => {
      throw Object.assign(new Error('missing'), { name: 'UserNotFoundException' });
    }) });
    expect(await missing(subject)).toBeNull();
    const outage = createCognitoCurrentWorkforceApplicant({ send: vi.fn(async () => { throw new Error('provider outage'); }) });
    await expect(outage(subject)).rejects.toThrow('provider outage');
  });

  it('rejects a malformed subject before calling Cognito', async () => {
    const send = vi.fn(async () => confirmed());
    const read = createCognitoCurrentWorkforceApplicant({ send });
    expect(await read('not-a-subject')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
