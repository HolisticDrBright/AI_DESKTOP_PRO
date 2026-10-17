import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { WORKFORCE_SUBJECT } from './contract';
import { CampaignError } from './practice-context';

/**
 * Whether a practitioner's workforce LOGIN has been revoked for a suspected compromise (staff-revocation-signal/2).
 *
 * The campaign engine authorizes staff from the verified token's claims and its own role grants. It never reads the
 * clinical identity row, and must not. Without this, a login revoked there would keep every staff operation here (the
 * practice's contacts, templates, sequences, broadcasts and test sends) until its ID token expires.
 *
 * So the emergency revocation publishes into a table of its own (alp-campaign-staff-revocations), and the staff route
 * and the sending job read it, strongly consistent, by two keys:
 *   - `<subject>`: any item at all is a revocation, exactly as under /1. Never deleted or overwritten here, and the
 *     writer's role cannot delete it: a revoked login is never restored (a replacement credential is a new subject).
 *   - `pending#<subject>`: a revocation is being decided right now. The emergency revocation writes it before the
 *     clinical decision commits, so an old token is refused from that moment, not only once the decision is published.
 *     It blocks exactly like a revocation, except that the sending job records no hold for it, and it lapses at its
 *     `pendingUntil`: a decision that was declined, or failed, never revokes a login here for good. `#` is never part
 *     of a subject, so the two keys cannot collide.
 *   - neither, or only a pending item past its deadline: the request goes on, under the engine's own role checks.
 *   - either read fails or times out, or no signal is configured: refused as unavailable (503). An outage never reads as
 *     "not revoked". A pending item whose `pendingUntil` is missing, unreadable or too far ahead never lapses.
 * The table holds the subject, an identifier, and the revocation's or decision's id: never a token, email or name. The
 * public sign-up, confirm and unsubscribe routes never read it, so a subscriber is never turned away by it.
 */
export const STAFF_REVOCATION_SIGNAL_CONTRACT = 'staff-revocation-signal/2';
/** The longest a pending decision can hold a login here. A `pendingUntil` further ahead than this is malformed. */
export const STAFF_REVOCATION_PENDING_MAX_MS = 31 * 60_000;
/** The key a decision in progress is written under: never a subject, because `#` is never part of one. */
export const pendingSignalKey = (subject: string) => `pending#${subject}`;
/** The workforce subject (the ID token's `sub`), in the form the revocation records it. */
export { WORKFORCE_SUBJECT };
export type StaffRevocationStatus = 'revoked' | 'pending' | 'clear';

export interface StaffRevocationSignal {
  /** What the signal says about the subject now. Throws when that cannot be read: never answers "clear" instead. */
  status(subject: string): Promise<StaffRevocationStatus>;
  /** true unless the subject is clear: revoked, or a revocation is being decided. Throws when that cannot be read. */
  revoked(subject: string): Promise<boolean>;
}

/** The two items, read as a status. A revocation always wins; only a well-formed pending item past its deadline lapses. */
export function staffRevocationStatusOf(items: { revoked?: Record<string, unknown>; pending?: Record<string, unknown> }, now: number): StaffRevocationStatus {
  if (items.revoked) return 'revoked';
  if (!items.pending) return 'clear';
  const until = typeof items.pending.pendingUntil === 'string' ? Date.parse(items.pending.pendingUntil) : Number.NaN;
  if (!Number.isFinite(until) || until > now + STAFF_REVOCATION_PENDING_MAX_MS) return 'pending';
  return until <= now ? 'clear' : 'pending';
}

export function createDynamoStaffRevocationSignal(input: {
  client: Pick<DynamoDBDocumentClient, 'send'>; tableName: string; timeoutMs?: number; now?: () => number;
}): StaffRevocationSignal {
  const send = input.client.send as (command: unknown, options?: unknown) => Promise<{ Item?: Record<string, unknown> }>;
  const now = input.now ?? Date.now;
  const read = (key: string, names: Record<string, string>) => send(new GetCommand({ TableName: input.tableName, Key: { subject: key }, ConsistentRead: true,
    ProjectionExpression: Object.keys(names).join(', '), ExpressionAttributeNames: names }), { abortSignal: AbortSignal.timeout(input.timeoutMs ?? 3000) });
  const status = async (subject: string): Promise<StaffRevocationStatus> => {
    if (!WORKFORCE_SUBJECT.test(subject)) throw new CampaignError('forbidden', 'identity_refused');
    let replies: [{ Item?: Record<string, unknown> }, { Item?: Record<string, unknown> }];
    try {
      replies = await Promise.all([read(subject, { '#s': 'subject' }), read(pendingSignalKey(subject), { '#s': 'subject', '#u': 'pendingUntil' })]);
    } catch { throw new CampaignError('unavailable', 'staff_revocation_unavailable'); }
    return staffRevocationStatusOf({ revoked: replies[0].Item, pending: replies[1].Item }, now());
  };
  return { status, async revoked(subject) { return (await status(subject)) !== 'clear'; } };
}

/** A fictional signal for tests and the local fixture: revoke a subject, hold one pending, or take the signal down. */
export function createFictionalStaffRevocationSignal() {
  const states = new Map<string, Exclude<StaffRevocationStatus, 'clear'>>();
  const reads: string[] = [];
  let down = false;
  const status = async (subject: string): Promise<StaffRevocationStatus> => {
    reads.push(subject);
    if (down) throw new CampaignError('unavailable', 'staff_revocation_unavailable');
    return states.get(subject) ?? 'clear';
  };
  return {
    signal: { status, async revoked(subject: string) { return (await status(subject)) !== 'clear'; } } satisfies StaffRevocationSignal,
    reads,
    revoke(subject: string) { states.set(subject, 'revoked'); },
    pend(subject: string) { if (states.get(subject) !== 'revoked') states.set(subject, 'pending'); },
    lapse(subject: string) { if (states.get(subject) === 'pending') states.delete(subject); },
    outage(on: boolean) { down = on; },
  };
}
