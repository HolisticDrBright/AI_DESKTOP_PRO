import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CampaignError } from './practice-context';

/**
 * Whether a practitioner's workforce LOGIN has been revoked for a suspected compromise (staff-revocation-signal/1).
 *
 * The campaign engine authorizes staff from the verified token's claims and its own role grants. It never reads the
 * clinical identity row, and must not. Without this, a login revoked there would keep every staff operation here (the
 * practice's contacts, templates, sequences, broadcasts and test sends) until its ID token expires.
 *
 * So the emergency revocation publishes one item per revoked workforce subject into a table of its own
 * (alp-campaign-staff-revocations), and the staff route reads it, strongly consistent, before every staff operation:
 *   - an item for the token's subject: refused, whatever the token (403 `identity_refused`);
 *   - no item: the request goes on, under the engine's own role checks;
 *   - the read fails or times out, or no signal is configured: refused as unavailable (503). An outage never reads as
 *     "not revoked".
 * The item is never deleted or overwritten here: a revoked login is never restored (a replacement credential is a new
 * subject). The table holds the subject, an identifier, and the revocation's id: never a token, email or name. The
 * public sign-up, confirm and unsubscribe routes never read it, so a subscriber is never turned away by it.
 */
export const STAFF_REVOCATION_SIGNAL_CONTRACT = 'staff-revocation-signal/1';
/** The workforce subject (the ID token's `sub`), in the form the revocation records it. */
export const WORKFORCE_SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;

export interface StaffRevocationSignal {
  /** true when the subject's login is revoked. Throws when that cannot be read: never answers "not revoked" instead. */
  revoked(subject: string): Promise<boolean>;
}

export function createDynamoStaffRevocationSignal(input: {
  client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; timeoutMs?: number;
}): StaffRevocationSignal {
  const send = input.client.send as (command: unknown, options?: unknown) => Promise<{ Item?: Record<string, unknown> }>;
  return {
    async revoked(subject) {
      if (!WORKFORCE_SUBJECT.test(subject)) throw new CampaignError('forbidden', 'identity_refused');
      let reply: { Item?: Record<string, unknown> };
      try {
        reply = await send(new GetCommand({ TableName: input.tableName, Key: { subject }, ConsistentRead: true, ProjectionExpression: '#s', ExpressionAttributeNames: { '#s': 'subject' } }),
          { abortSignal: AbortSignal.timeout(input.timeoutMs ?? 3000) });
      } catch { throw new CampaignError('unavailable', 'staff_revocation_unavailable'); }
      // Any item at all is a revocation: a malformed one is never read as "not revoked".
      return reply.Item !== undefined;
    },
  };
}

/** A fictional signal for tests and the local fixture: revoke a subject, or take the signal down. */
export function createFictionalStaffRevocationSignal() {
  const revokedSubjects = new Set<string>();
  const reads: string[] = [];
  let down = false;
  return {
    signal: {
      async revoked(subject: string) {
        reads.push(subject);
        if (down) throw new CampaignError('unavailable', 'staff_revocation_unavailable');
        return revokedSubjects.has(subject);
      },
    } satisfies StaffRevocationSignal,
    reads,
    revoke(subject: string) { revokedSubjects.add(subject); },
    outage(on: boolean) { down = on; },
  };
}
