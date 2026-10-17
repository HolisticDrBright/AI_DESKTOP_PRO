import { MAX_SEND_AUTHORITIES, type Broadcast, type EmailSequence, type EmailTemplate, type SendAuthority, type SendHold } from './contract';
import { CampaignError, type EngineDeps } from './practice-context';

/**
 * Send authority (send-authority/1, see contract.ts): which logins a queued send rests on, and whether any of them is
 * revoked right now. Shared by the staff actions that queue a send, the sending job that checks it immediately before
 * each SES call, and the review that resumes a held one.
 */
type Queued = Pick<Broadcast | EmailSequence, 'authorizedBy' | 'hold'>;

/**
 * The record's authority with this staff member's action added. Nobody is removed: a later edit, pause or start by
 * someone else adds them beside whoever was there. One entry per login, the latest action kept.
 *
 * A record that was already queued before send authority existed (`queued` and no list) gains the editor but is held
 * as unrecorded at once: whoever queued it originally is unknown, so an edit by someone else must not make it trusted.
 */
export function withAuthority<T extends Queued>(record: T, entry: SendAuthority, options: { queued: boolean }): T {
  const before = record.authorizedBy;
  const authorizedBy = [...(before ?? []).filter(a => a.subject !== entry.subject), entry];
  if (authorizedBy.length > MAX_SEND_AUTHORITIES) throw new CampaignError('conflict', 'review_required_before_more_edits');
  const unrecorded = before === undefined && options.queued && !record.hold;
  return { ...record, authorizedBy, ...(unrecorded ? { hold: { reason: 'authority_unrecorded', at: entry.at, persons: [] } satisfies SendHold } : {}) };
}

export type AuthorityCheck = { state: 'clear' } | { state: 'unavailable' } | { state: 'held'; hold: SendHold };

/**
 * Whether a queued send may go to SES now. Every recorded login (the record's and each email's approver) is re-read
 * from the revocation signal; nothing is cached between calls. A held record stays held whatever the signal says.
 * An unconfigured or unreadable signal, or a revocation still being decided (`pending`), is `unavailable`: the caller
 * sends nothing and records nothing.
 */
export async function checkSendAuthority(deps: Pick<EngineDeps, 'staffRevocation'>, record: Queued, templates: EmailTemplate[], at: string): Promise<AuthorityCheck> {
  if (record.hold) return { state: 'held', hold: record.hold };
  if (!record.authorizedBy?.length) return { state: 'held', hold: { reason: 'authority_unrecorded', at, persons: [] } };
  // Nobody is named: an approval with no recorded login says nothing about anyone's login.
  if (templates.some(t => !t.approval?.by.subject)) return { state: 'held', hold: { reason: 'approval_unattributed', at, persons: [] } };
  if (!deps.staffRevocation) return { state: 'unavailable' };
  const signal = deps.staffRevocation;
  const subjects = unique([...record.authorizedBy.map(a => a.subject), ...templates.map(t => t.approval!.by.subject!)]);
  let revoked: Set<string>, pending: boolean;
  try {
    const answers = await Promise.all(subjects.map(async subject => [subject, await signal.status(subject)] as const));
    revoked = new Set(answers.filter(([, s]) => s === 'revoked').map(([s]) => s));
    pending = answers.some(([, s]) => s === 'pending');
  } catch { return { state: 'unavailable' }; }
  const authorities = record.authorizedBy.filter(a => revoked.has(a.subject));
  if (authorities.length) return { state: 'held', hold: { reason: 'authority_revoked', at, persons: unique(authorities.map(a => a.personId)) } };
  const approvals = templates.filter(t => revoked.has(t.approval!.by.subject!));
  if (approvals.length) return { state: 'held', hold: { reason: 'approval_revoked', at, persons: unique(approvals.map(t => t.approval!.by.personId)) } };
  // A revocation being decided right now: nothing is sent, and nothing is recorded, so a declined one leaves no trace.
  if (pending) return { state: 'unavailable' };
  return { state: 'clear' };
}

const unique = <T>(values: T[]) => [...new Set(values)];
