import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { STAFF_REVOCATION_SIGNAL_CONTRACT, createDynamoStaffRevocationSignalPublisher, signalFailure } from './staff-revocation-signal';
import { WorkforceProviderFailure } from './workforce-identity-revocation';

/** The campaign staff revocation signal's writer, at its DynamoDB SDK boundary. Fictional subjects only. */
const SUBJECT = 'fictional-workforce-subject-0001';
function client(reply: unknown = {}) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return { calls, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (reply instanceof Error) throw reply;
    return reply;
  } };
}

describe('the staff revocation signal publisher', () => {
  it('writes one item per subject, only if none is there: never an overwrite, never a delete', async () => {
    const c = client();
    const revocationId = randomUUID();
    await createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 'alp-campaign-staff-revocations' }).publish(SUBJECT, revocationId.toUpperCase());
    expect(c.calls).toEqual([{ name: 'PutCommand', input: {
      TableName: 'alp-campaign-staff-revocations',
      Item: { subject: SUBJECT, revocationId, contract: STAFF_REVOCATION_SIGNAL_CONTRACT },
      ConditionExpression: 'attribute_not_exists(#s)', ExpressionAttributeNames: { '#s': 'subject' },
    } }]);
    expect(STAFF_REVOCATION_SIGNAL_CONTRACT).toBe('staff-revocation-signal/1');
  });

  it('an item already there is success: the subject is revoked there, which is all the signal says', async () => {
    const c = client(Object.assign(new Error('fictional'), { name: 'ConditionalCheckFailedException' }));
    await expect(createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 't-1' }).publish(SUBJECT, randomUUID())).resolves.toBeUndefined();
  });

  it('every other failure is a closed code that never carries the message, so the step stays actionable', async () => {
    const secret = 'eyJfictional.token and a@b.example';
    for (const [name, code] of [['ResourceNotFoundException', 'not_found'], ['ProvisionedThroughputExceededException', 'throttled'], ['RequestLimitExceeded', 'throttled'],
      ['AccessDeniedException', 'access_denied'], ['TimeoutError', 'timeout'], ['AbortError', 'timeout'], ['InternalServerError', 'unavailable'], ['Other', 'unknown']] as const) {
      const failure = await createDynamoStaffRevocationSignalPublisher({ client: client(Object.assign(new Error(secret), { name })) as never, tableName: 't-1' })
        .publish(SUBJECT, randomUUID()).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkforceProviderFailure);
      expect([name, (failure as WorkforceProviderFailure).code]).toEqual([name, code]);
      expect(JSON.stringify(failure) + String(failure)).not.toContain('eyJ');
      expect(signalFailure({ name })).toBe(code);
    }
  });

  it('refuses a malformed subject or revocation id without writing', async () => {
    const c = client();
    const publisher = createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 't-1' });
    await expect(publisher.publish('bad name!', randomUUID())).rejects.toMatchObject({ code: 'unknown' });
    await expect(publisher.publish(SUBJECT, 'not-a-uuid')).rejects.toMatchObject({ code: 'unknown' });
    expect(c.calls).toEqual([]);
  });
});
