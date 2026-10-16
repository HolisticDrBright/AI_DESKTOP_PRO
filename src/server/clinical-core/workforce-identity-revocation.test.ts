import { describe, expect, it, vi } from 'vitest';
import { AdminDisableUserCommand, AdminUserGlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';
import type { ClinicalCoreDatabase } from './database';
import {
  WORKFORCE_IDENTITY_REVOCATION_RELEASE, WorkforceIdentityRevocationError, WorkforceProviderFailure, createCognitoWorkforceIdentityProvider,
  createWorkforceIdentityRevocation, providerFailure,
} from './workforce-identity-revocation';

const POOL = 'us-east-1_FictWork1';
const OPERATOR_POOL = 'us-east-1_FictOper1';
const CONSUMER_POOL = 'us-east-1_FictCons1';

describe('the emergency revocation service while its release is blocked', () => {
  it('is blocked in source, and refuses before it reads the database, the fence or the provider', async () => {
    expect(WORKFORCE_IDENTITY_REVOCATION_RELEASE).toBe('blocked');
    const database = { transaction: vi.fn() } as unknown as ClinicalCoreDatabase;
    const provider = { revoke: vi.fn() };
    const fence = { begin: vi.fn() };
    const service = createWorkforceIdentityRevocation({ database, provider, fence });
    const body = { requestId: randomUUID(), identitySubject: randomUUID(), reason: 'suspected_compromise' };
    for (const work of [service.propose(randomUUID(), body), service.decide(randomUUID(), { proposalId: randomUUID(), decision: 'approve' }),
      service.reconcile(randomUUID()), service.list(randomUUID())]) {
      await expect(work).rejects.toMatchObject({ code: 'not_released' });
    }
    expect(database.transaction).not.toHaveBeenCalled();
    expect(fence.begin).not.toHaveBeenCalled();
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it('released for qualification, it still refuses a malformed operator or request before the database', async () => {
    const database = { transaction: vi.fn() } as unknown as ClinicalCoreDatabase;
    const service = createWorkforceIdentityRevocation({ database, provider: { revoke: vi.fn() }, release: 'qualification' });
    await expect(service.propose('not-an-operator', {})).rejects.toMatchObject({ code: 'operator_refused' });
    for (const body of [{}, { requestId: randomUUID(), identitySubject: randomUUID(), reason: 'because' },
      { requestId: randomUUID(), identitySubject: 'x', reason: 'suspected_compromise' },
      { requestId: randomUUID(), identitySubject: randomUUID(), reason: 'suspected_compromise', clinicId: randomUUID() }]) {
      await expect(service.propose(randomUUID(), body)).rejects.toMatchObject({ code: 'request_invalid' });
    }
    await expect(service.decide(randomUUID(), { proposalId: randomUUID(), decision: 'restore' })).rejects.toMatchObject({ code: 'request_invalid' });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

describe('the Cognito workforce adapter', () => {
  it('is bound to the one workforce pool it was built for and refuses to be built for another pool', () => {
    const client = { send: vi.fn() };
    expect(() => createCognitoWorkforceIdentityProvider({ client, workforcePoolId: OPERATOR_POOL, otherPoolIds: [OPERATOR_POOL, CONSUMER_POOL] }))
      .toThrow('workforce_identity_provider_configuration_invalid');
    expect(() => createCognitoWorkforceIdentityProvider({ client, workforcePoolId: 'arn:aws:cognito-idp:pool', otherPoolIds: [] }))
      .toThrow('workforce_identity_provider_configuration_invalid');
    expect(() => createCognitoWorkforceIdentityProvider({ client, workforcePoolId: POOL, otherPoolIds: [OPERATOR_POOL, CONSUMER_POOL] })).not.toThrow();
  });

  it('disables, then signs out globally, always in the workforce pool, and never sends anything else', async () => {
    const client = { send: vi.fn(async (_command: unknown) => ({})) };
    const provider = createCognitoWorkforceIdentityProvider({ client, workforcePoolId: POOL, otherPoolIds: [OPERATOR_POOL] });
    const subject = randomUUID();
    await provider.revoke('disable_user', subject);
    await provider.revoke('global_sign_out', subject);
    const sent = client.send.mock.calls.map(call => call[0] as unknown as AdminDisableUserCommand | AdminUserGlobalSignOutCommand);
    expect(sent.map(command => command.constructor.name)).toEqual(['AdminDisableUserCommand', 'AdminUserGlobalSignOutCommand']);
    for (const command of sent) expect(command.input).toEqual({ UserPoolId: POOL, Username: subject });
    await expect(provider.revoke('disable_user', 'bad name!')).rejects.toMatchObject({ code: 'unknown' });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('reduces every provider error to a closed code and never carries its message', async () => {
    const secret = 'eyJfictional.token.value and a@b.example';
    for (const [name, code] of [['UserNotFoundException', 'not_found'], ['TooManyRequestsException', 'throttled'], ['LimitExceededException', 'throttled'],
      ['NotAuthorizedException', 'access_denied'], ['AccessDeniedException', 'access_denied'], ['TimeoutError', 'timeout'],
      ['InternalErrorException', 'unavailable'], ['SomethingElse', 'unknown']] as const) {
      const client = { send: vi.fn(async () => { throw Object.assign(new Error(secret), { name }); }) };
      const provider = createCognitoWorkforceIdentityProvider({ client, workforcePoolId: POOL, otherPoolIds: [] });
      const failure = await provider.revoke('global_sign_out', randomUUID()).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkforceProviderFailure);
      expect((failure as WorkforceProviderFailure).code).toBe(code);
      expect(JSON.stringify(failure) + String(failure)).not.toContain('eyJ');
      expect(providerFailure({ name })).toBe(code);
    }
  });

  it('a revocation error carries only its code', () => {
    const error = new WorkforceIdentityRevocationError('fence_required');
    expect(Object.keys(error).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(error)).toBe('{"code":"fence_required","name":"WorkforceIdentityRevocationError"}');
    expect(error.message).toBe('fence_required');
  });
});
