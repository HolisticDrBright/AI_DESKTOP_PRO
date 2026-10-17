import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PENDING_TTL_MS, STAFF_REVOCATION_SIGNAL_CONTRACT, createDynamoStaffRevocationSignalPublisher, signalFailure } from './staff-revocation-signal';
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
  it('publishes one revocation item per subject, only if none is there: never an overwrite, never a delete', async () => {
    const c = client();
    const revocationId = randomUUID();
    await createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 'alp-campaign-staff-revocations' }).publish(SUBJECT, revocationId.toUpperCase());
    expect(c.calls).toEqual([{ name: 'PutCommand', input: {
      TableName: 'alp-campaign-staff-revocations',
      Item: { subject: SUBJECT, revocationId, contract: STAFF_REVOCATION_SIGNAL_CONTRACT },
      ConditionExpression: 'attribute_not_exists(#s)', ExpressionAttributeNames: { '#s': 'subject' },
    } }]);
    expect(STAFF_REVOCATION_SIGNAL_CONTRACT).toBe('staff-revocation-signal/2');
  });

  it('holds a pending decision under its own key, never the subject\'s, and it lapses by itself', async () => {
    const c = client();
    const decisionId = randomUUID(), NOW = Date.parse('2026-10-17T12:00:00Z');
    await createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 't-1', now: () => NOW }).hold(SUBJECT, decisionId.toUpperCase());
    expect(c.calls).toEqual([{ name: 'PutCommand', input: {
      TableName: 't-1',
      Item: { subject: `pending#${SUBJECT}`, decisionId, pendingUntil: new Date(NOW + PENDING_TTL_MS).toISOString(), expiresAt: Math.ceil((NOW + PENDING_TTL_MS) / 1000),
        contract: STAFF_REVOCATION_SIGNAL_CONTRACT },
    } }]);
    expect(PENDING_TTL_MS).toBe(30 * 60_000);
  });

  it('releases only its own decision\'s pending item, by the pending key: never the revocation item', async () => {
    const c = client();
    const decisionId = randomUUID();
    await createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 't-1' }).release(SUBJECT, decisionId);
    expect(c.calls).toEqual([{ name: 'DeleteCommand', input: { TableName: 't-1', Key: { subject: `pending#${SUBJECT}` }, ConditionExpression: '#d = :decision',
      ExpressionAttributeNames: { '#d': 'decisionId' }, ExpressionAttributeValues: { ':decision': decisionId } } }]);
  });

  it('a failed condition is success: already revoked there, or nothing of this decision\'s to release', async () => {
    const c = client(Object.assign(new Error('fictional'), { name: 'ConditionalCheckFailedException' }));
    const publisher = createDynamoStaffRevocationSignalPublisher({ client: c as never, tableName: 't-1' });
    await expect(publisher.publish(SUBJECT, randomUUID())).resolves.toBeUndefined();
    await expect(publisher.release(SUBJECT, randomUUID())).resolves.toBeUndefined();
    // A pending write has no condition: a failure there is a failure.
    await expect(publisher.hold(SUBJECT, randomUUID())).rejects.toMatchObject({ code: 'unknown' });
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
    await expect(publisher.hold('bad name!', randomUUID())).rejects.toMatchObject({ code: 'unknown' });
    await expect(publisher.release(SUBJECT, 'not-a-uuid')).rejects.toMatchObject({ code: 'unknown' });
    expect(c.calls).toEqual([]);
  });
});
