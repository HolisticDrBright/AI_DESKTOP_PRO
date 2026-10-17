if (typeof window !== 'undefined') throw new Error('staff-revocation-signal is server-only');
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { WorkforceProviderFailure, type ProviderFailure, type StaffRevocationSignalPublisher } from './workforce-identity-revocation';

/**
 * The writer of the campaign staff revocation signal (staff-revocation-signal/1), for the emergency revocation's
 * operator service. BLOCKED with that service: nothing constructs it, and no IAM grant or table exists for it yet.
 *
 * The campaign engine never reads the clinical identity row. Its staff route instead reads this table, keyed by the
 * workforce subject, and refuses every staff operation for a subject found there (src/campaigns/staff-revocation.ts,
 * which keeps its own copy of the contract: the two code paths share no module).
 *
 * One item per revoked subject: the subject (an identifier, never a token, email or name), the revocation's id and the
 * contract. It is written once and never overwritten or deleted: a second publication for the same subject, from a
 * retry or a later revocation, finds it there and succeeds without changing it. A revoked login is never restored.
 */
export const STAFF_REVOCATION_SIGNAL_CONTRACT = 'staff-revocation-signal/1';
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDynamoStaffRevocationSignalPublisher(input: {
  client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; timeoutMs?: number;
}): StaffRevocationSignalPublisher {
  const send = input.client.send as (command: unknown, options?: unknown) => Promise<unknown>;
  return {
    async publish(subject, revocationId) {
      if (!SUBJECT.test(subject) || !UUID.test(revocationId)) throw new WorkforceProviderFailure('unknown');
      try {
        await send(new PutCommand({
          TableName: input.tableName,
          Item: { subject, revocationId: revocationId.toLowerCase(), contract: STAFF_REVOCATION_SIGNAL_CONTRACT },
          ConditionExpression: 'attribute_not_exists(#s)', ExpressionAttributeNames: { '#s': 'subject' },
        }), { abortSignal: AbortSignal.timeout(input.timeoutMs ?? 5000) });
      } catch (error) {
        // Already published: the subject is revoked there, which is all the signal says. Never overwritten.
        if (String((error as { name?: unknown })?.name ?? '') === 'ConditionalCheckFailedException') return;
        throw new WorkforceProviderFailure(signalFailure(error));
      }
    },
  };
}

/** A DynamoDB error, reduced to a closed code. The message is never read. */
export function signalFailure(error: unknown): ProviderFailure {
  const name = String((error as { name?: unknown })?.name ?? '');
  if (name === 'ResourceNotFoundException') return 'not_found';
  if (name === 'ProvisionedThroughputExceededException' || name === 'RequestLimitExceeded' || name === 'ThrottlingException') return 'throttled';
  if (name === 'AccessDeniedException' || name === 'UnrecognizedClientException') return 'access_denied';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'InternalServerError' || name === 'ServiceUnavailable') return 'unavailable';
  return 'unknown';
}
