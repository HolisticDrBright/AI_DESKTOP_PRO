if (typeof window !== 'undefined') throw new Error('staff-revocation-signal is server-only');
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { WorkforceProviderFailure, type ProviderFailure, type StaffRevocationSignalPublisher } from './workforce-identity-revocation';

/**
 * The writer of the campaign staff revocation signal (staff-revocation-signal/2), for the emergency revocation's
 * operator service. BLOCKED with that service: nothing constructs it, and no IAM grant or table exists for it yet.
 *
 * The campaign engine never reads the clinical identity row. Its staff route and sending job instead read this table
 * (src/campaigns/staff-revocation.ts, which keeps its own copy of the contract: the two code paths share no module).
 *
 * Two phases, so that an old campaign token is refused from before the clinical decision commits, without the
 * clinical decision ever waiting on DynamoDB. Each phase has its own key:
 *   - `hold`, under `pending#<subject>`: written as a decision that can take effect starts, never awaited by it. The
 *     decision's id and `pendingUntil` (now + PENDING_TTL_MS). It blocks the login at once and lapses by itself, so a
 *     declined or failed decision can never revoke a login there for good.
 *   - `publish`, under `<subject>`: once the decision has taken effect. Exactly the /1 item: the subject, the
 *     revocation's id and the contract, written once and never overwritten. A second publication for the same subject,
 *     from a retry or a later revocation, finds it there and succeeds without changing it.
 *   - `release`: when the decision definitely did not take effect. Deletes `pending#<subject>` only while it is still
 *     this decision's. It never touches `<subject>`, and the writer's role must not be able to (see the IAM statement
 *     in docs/revocation-signal-timing-2026-10-17.md): a revoked login is never restored.
 * Every item holds a key derived from the subject (an identifier, never a token, email or name), an id and the contract.
 */
export const STAFF_REVOCATION_SIGNAL_CONTRACT = 'staff-revocation-signal/2';
/** How long a pending decision holds a login at the campaign engine if nobody publishes or releases it. */
export const PENDING_TTL_MS = 30 * 60_000;
const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingKey = (subject: string) => `pending#${subject}`;

export function createDynamoStaffRevocationSignalPublisher(input: {
  client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; timeoutMs?: number; now?: () => number;
}): StaffRevocationSignalPublisher {
  const send = input.client.send as (command: unknown, options?: unknown) => Promise<unknown>;
  const now = input.now ?? Date.now;
  const options = () => ({ abortSignal: AbortSignal.timeout(input.timeoutMs ?? 5000) });
  const valid = (subject: string, id: string) => { if (!SUBJECT.test(subject) || !UUID.test(id)) throw new WorkforceProviderFailure('unknown'); };
  /** A failed condition is the outcome the phase wants already in place; anything else is a closed code. */
  const settled = (error: unknown) => {
    if (String((error as { name?: unknown })?.name ?? '') === 'ConditionalCheckFailedException') return;
    throw new WorkforceProviderFailure(signalFailure(error));
  };
  return {
    async publish(subject, revocationId) {
      valid(subject, revocationId);
      try {
        await send(new PutCommand({
          TableName: input.tableName,
          Item: { subject, revocationId: revocationId.toLowerCase(), contract: STAFF_REVOCATION_SIGNAL_CONTRACT },
          ConditionExpression: 'attribute_not_exists(#s)', ExpressionAttributeNames: { '#s': 'subject' },
        }), options());
      } catch (error) {
        // Already published: the subject is revoked there, which is all the signal says. Never overwritten.
        settled(error);
      }
    },
    async hold(subject, decisionId) {
      valid(subject, decisionId);
      const until = now() + PENDING_TTL_MS;
      // `expiresAt` lets DynamoDB's own TTL remove a lapsed pending item; the reader never relies on it.
      await send(new PutCommand({ TableName: input.tableName, Item: { subject: pendingKey(subject), decisionId: decisionId.toLowerCase(),
        pendingUntil: new Date(until).toISOString(), expiresAt: Math.ceil(until / 1000), contract: STAFF_REVOCATION_SIGNAL_CONTRACT } }), options())
        .catch(error => { throw new WorkforceProviderFailure(signalFailure(error)); });
    },
    async release(subject, decisionId) {
      valid(subject, decisionId);
      try {
        await send(new DeleteCommand({ TableName: input.tableName, Key: { subject: pendingKey(subject) }, ConditionExpression: '#d = :decision',
          ExpressionAttributeNames: { '#d': 'decisionId' }, ExpressionAttributeValues: { ':decision': decisionId.toLowerCase() } }), options());
      } catch (error) {
        // Gone already, or another decision's: nothing of this one's is there.
        settled(error);
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
