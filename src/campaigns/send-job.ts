import type { Broadcast, CampaignProgram, EmailSequence, EmailTemplate, SendHold } from './contract';
import { renderEmail } from './content';
import { contactId, DAY_MS, loadPractice, nextSendWindow, withinSendHours, type ContactBody, type EngineDeps, type PracticeContext } from './practice-context';
import { checkSendAuthority, type AuthorityCheck } from './send-authority';
import { tenantNameFor, type SendReply } from './ses';
import { unsubscribeToken } from './workforce';

/**
 * The scheduled sending job: one pass every 5 minutes (EventBridge Scheduler, `rate(5 minutes)`), sending whatever
 * sequence steps and broadcasts are due across every practice that holds the marketing entitlement.
 *
 * **Why one periodic pass, not one schedule per person.** A schedule per subscriber per step would mean thousands of
 * schedules per practice, every one created, moved and deleted on each sign-up, edit and unsubscribe, against the
 * Scheduler's per-account schedule and API-rate quotas. One pass reads a sparse "due" index instead: an unsubscribe
 * only clears an item, an edit to a sequence takes effect at the next pass, and the job's cost is bounded per pass.
 *
 * **Never twice.** Before an email goes out, the pass writes a create-only claim for exactly that send (the step for
 * that person, or the broadcast for that person). A second pass, a retry or a concurrent run finds the claim and
 * sends nothing. If SES answers with an error, the email was definitely not accepted, the claim is released, and a
 * later pass tries again. If SES gives no answer at all, the email may have gone out, so the claim stays and the email
 * is never retried; the pass counts it as `unknown`.
 *
 * **Rate and hours.** Sends are paced to the account's SES sending rate and capped by the practice's monthly email
 * allowance. Nothing is sent outside 08:00 to 20:00 in the subscriber's time zone: a contact's own zone is not
 * collected at sign-up, so the practice's zone is the inferred one. A send that falls outside the window waits for the
 * next 08:00 there.
 *
 * **Send authority** (send-authority/1, contract.ts). A queued send rests on the logins that scheduled, started or
 * edited it and approved its email. Each one is re-read from the emergency revocation's signal before a broadcast
 * starts, at each page of it, and for every email after its claim is written and immediately before SES is called. A
 * revoked one holds the send and records the hold on it; the claim and the month's count are given back. An unreadable
 * signal holds the email for this pass only, and a sender with no signal configured sends nothing at all.
 *
 * What this cannot do: an email already handed to SES when the revocation lands is not recalled. Sends are one at a
 * time, so that is at most one email per practice per pass, and every later one is held.
 */
export type PassSummary = { practices: number; sent: number; deferred: number; held: number; unknown: number; failed: number; skipped: { practiceId: string; reason: string }[] };
const SENDS_PER_PRACTICE_PER_PASS = 500;

export function createSendJob(deps: EngineDeps) {
  const now = () => deps.now?.() ?? new Date();
  const pause = deps.pause ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  return async function runPass(): Promise<PassSummary> {
    const summary: PassSummary = { practices: 0, sent: 0, deferred: 0, held: 0, unknown: 0, failed: 0, skipped: [] };
    if (!deps.config.enabled) return summary;
    let rate = 1;
    try { rate = Math.max(1, Math.floor(await deps.ses.maxSendRate())); } catch { rate = 1; }
    const gap = Math.ceil(1000 / rate);
    let after: string | null = null;
    do {
      const page: { items: { id: string }[]; after: string | null } = await deps.store.global.query('marketing_practice', { after, limit: 100 });
      after = page.after;
      for (const { id: practiceId } of page.items) {
        summary.practices++;
        const ctx = await loadPractice(deps, practiceId);
        if (!ctx.readiness.canSend) { summary.skipped.push({ practiceId, reason: ctx.readiness.missing[0] ?? 'not_ready' }); continue; }
        // Without the signal no send's authority can be checked: nothing is sent, never "not revoked".
        if (!deps.staffRevocation) { summary.skipped.push({ practiceId, reason: 'staff_revocation_unconfigured' }); continue; }
        const budget = { left: SENDS_PER_PRACTICE_PER_PASS };
        await sequences(ctx, budget, summary, gap);
        await broadcasts(ctx, budget, summary, gap);
      }
    } while (after);
    return summary;
  };

  /** Records a hold on the sequence or broadcast. If that write fails or races, the email is held anyway and the next pass records it. */
  async function persistHold(ctx: PracticeContext, kind: 'sequence' | 'broadcast', id: string, hold: SendHold) {
    try {
      const item = await ctx.store.get<Broadcast | EmailSequence>(kind, id);
      if (item && !item.body.hold) await ctx.store.put(kind, id, { ...item.body, hold }, { expected: item.version });
    } catch { /* held either way */ }
  }
  /** The authority check for one queued record, read fresh from the store each time it is called. */
  function authorityOf(ctx: PracticeContext, kind: 'sequence' | 'broadcast', id: string, template: EmailTemplate) {
    return async (): Promise<AuthorityCheck> => {
      const item = await ctx.store.get<Broadcast | EmailSequence>(kind, id);
      if (!item) return { state: 'unavailable' };
      const check = await checkSendAuthority(deps, item.body, [template], now().toISOString());
      if (check.state === 'held' && !item.body.hold) await persistHold(ctx, kind, id, check.hold);
      return check;
    };
  }

  async function sendOne(ctx: PracticeContext, claimId: string, contact: ContactBody, template: EmailTemplate, kind: 'sequence' | 'broadcast', summary: PassSummary, gap: number,
    authorize: () => Promise<AuthorityCheck>): Promise<'sent' | 'already' | 'retry' | 'unknown' | 'failed' | 'cap' | 'held' | 'unavailable'> {
    const month = now().toISOString().slice(0, 7).replace('-', '');
    if (!await ctx.store.increment('counter', `emails-${month}`, 'sent', 1, ctx.allowance!.emailsPerMonth)) return 'cap';
    if (await ctx.store.put('send', claimId, { state: 'claimed', at: now().toISOString() }, { expected: null }) === 'conflict') {
      await ctx.store.increment('counter', `emails-${month}`, 'sent', -1);
      return 'already';
    }
    // The last check before SES, after the claim: a revocation from here on is the race this job cannot close.
    const authority = await authorize();
    if (authority.state !== 'clear') {
      const claimed = await ctx.store.get('send', claimId);
      if (claimed) await ctx.store.delete('send', claimId, claimed.version);
      await ctx.store.increment('counter', `emails-${month}`, 'sent', -1);
      summary.held++;
      return authority.state === 'held' ? 'held' : 'unavailable';
    }
    const origin = new URL(deps.config.siteOrigin).origin;
    const token = unsubscribeToken(deps, ctx.store.practiceId, contact.programKey, contact.emailHash, template.templateId);
    const rendered = renderEmail(template, { settings: ctx.settings, siteOrigin: deps.config.siteOrigin, firstName: contact.firstName,
      unsubscribeUrl: `${origin}/join/unsubscribe?t=${token}`, oneClickUrl: `${origin}/api/public/campaigns/unsubscribe?t=${token}` });
    let reply: SendReply;
    try {
      reply = await deps.ses.send({ from: `${ctx.settings.senderName} <${deps.config.fromLocalPart}@${ctx.settings.sendingDomain}>`, to: contact.email, ...rendered,
        configurationSet: ctx.settings.trackOpensAndClicks ? deps.config.trackedConfigurationSet : deps.config.configurationSet, tenant: tenantNameFor(ctx.store.practiceId),
        tags: [{ name: 'practice', value: ctx.store.practiceId }, { name: 'kind', value: kind }, { name: 'program', value: contact.programKey }, { name: 'template', value: template.templateId }, { name: 'contact', value: contact.emailHash }] });
    } catch { reply = { outcome: 'unknown' }; }
    await pause(gap);
    const claim = await ctx.store.get('send', claimId);
    if (reply.outcome === 'accepted') {
      if (claim) await ctx.store.put('send', claimId, { state: 'sent', messageId: reply.messageId, at: now().toISOString() }, { expected: claim.version });
      await ctx.store.increment('result', template.templateId, 'sent', 1);
      summary.sent++;
      return 'sent';
    }
    if (reply.outcome === 'unknown') {
      if (claim) await ctx.store.put('send', claimId, { state: 'unknown', at: now().toISOString() }, { expected: claim.version });
      summary.unknown++;
      return 'unknown';
    }
    // Definitely not accepted: release the claim so a later pass can try again, and give back the month's count.
    if (claim) await ctx.store.delete('send', claimId, claim.version);
    await ctx.store.increment('counter', `emails-${month}`, 'sent', -1);
    if (reply.detail === 'request_invalid') { summary.failed++; return 'failed'; }
    return 'retry';
  }

  async function sequences(ctx: PracticeContext, budget: { left: number }, summary: PassSummary, gap: number) {
    const at = now(), zone = ctx.settings.timeZone!;
    const due = await ctx.store.due<ContactBody>('contact', at.toISOString(), Math.min(200, budget.left));
    const sequenceCache = new Map<CampaignProgram, EmailSequence | null>();
    for (const item of due) {
      if (budget.left <= 0) return;
      const contact = item.body;
      const reschedule = (dueAt: string | null) => ctx.store.put('contact', item.id, contact, { expected: item.version, dueAt });
      if (contact.state !== 'confirmed' || !contact.enrollment) { await reschedule(null); continue; }
      if (!sequenceCache.has(contact.programKey)) sequenceCache.set(contact.programKey, (await ctx.store.get<EmailSequence>('sequence', contact.programKey))?.body ?? null);
      const sequence = sequenceCache.get(contact.programKey);
      if (!sequence || sequence.status === 'draft') { await reschedule(null); continue; }
      if (sequence.status === 'paused') { await reschedule(new Date(at.getTime() + DAY_MS).toISOString()); summary.held++; continue; }
      if (sequence.hold) { await reschedule(new Date(at.getTime() + 3_600_000).toISOString()); summary.held++; continue; }
      const enrollment = contact.enrollment;
      // The position after the last step this person received, in the sequence as it is now. A step added before it
      // is never sent to them; an edit to a step they have not reached is what they receive.
      const lastIndex = enrollment.lastSentStepId ? sequence.steps.findIndex(s => s.stepId === enrollment.lastSentStepId) : -1;
      const from = lastIndex >= 0 ? lastIndex + 1 : enrollment.lastSentStepId ? enrollment.lastSentPosition + 1 : 0;
      const next = sequence.steps.slice(from).find(s => !enrollment.sentStepIds.includes(s.stepId));
      if (!next) { await reschedule(null); continue; }
      const dueAt = new Date(Date.parse(enrollment.lastSentAt ?? enrollment.anchorAt) + next.waitDays * DAY_MS);
      if (dueAt > at) { await reschedule(dueAt.toISOString()); continue; }
      if (!withinSendHours(at, zone)) { await reschedule(nextSendWindow(at, zone).toISOString()); summary.deferred++; continue; }
      const template = (await ctx.store.get<EmailTemplate>('template', next.templateId))?.body;
      if (!template || template.status !== 'approved' || template.approval?.version !== template.version) { await reschedule(new Date(at.getTime() + 3_600_000).toISOString()); summary.held++; continue; }
      budget.left--;
      const outcome = await sendOne(ctx, `seq:${item.id}:${next.stepId}`, contact, template, 'sequence', summary, gap, authorityOf(ctx, 'sequence', contact.programKey, template));
      if (outcome === 'cap') { await reschedule(new Date(at.getTime() + DAY_MS).toISOString()); summary.skipped.push({ practiceId: ctx.store.practiceId, reason: 'monthly_email_allowance_reached' }); return; }
      if (outcome === 'retry') { await reschedule(new Date(at.getTime() + 900_000).toISOString()); continue; }
      // Held: everyone else on this sequence waits for the review, so read it again for them.
      if (outcome === 'held') { sequenceCache.delete(contact.programKey); await reschedule(new Date(at.getTime() + 3_600_000).toISOString()); continue; }
      // The signal could not be read: nobody else's authority can be checked this pass either.
      if (outcome === 'unavailable') { await reschedule(new Date(at.getTime() + 900_000).toISOString()); return; }
      // Sent, already sent, unknown or refused as invalid: the step is done for this person, never repeated.
      const position = sequence.steps.findIndex(s => s.stepId === next.stepId);
      const advanced: ContactBody = { ...contact, enrollment: { ...enrollment, sentStepIds: [...enrollment.sentStepIds, next.stepId], lastSentStepId: next.stepId, lastSentPosition: position, lastSentAt: at.toISOString() } };
      const following = sequence.steps.slice(position + 1)[0];
      const fresh = await ctx.store.get<ContactBody>('contact', item.id);
      if (!fresh || fresh.body.state !== 'confirmed') continue;
      await ctx.store.put('contact', item.id, { ...advanced, state: fresh.body.state }, { expected: fresh.version, dueAt: following ? new Date(at.getTime() + following.waitDays * DAY_MS).toISOString() : null });
    }
  }

  async function broadcasts(ctx: PracticeContext, budget: { left: number }, summary: PassSummary, gap: number) {
    const at = now(), zone = ctx.settings.timeZone!;
    const list = await ctx.store.query<Broadcast>('broadcast', { limit: 200 });
    for (const item of list.items) {
      let b = item.body, version = item.version;
      if ((b.status !== 'scheduled' && b.status !== 'sending') || !b.sendAt || Date.parse(b.sendAt) > at.getTime()) continue;
      if (b.hold) { summary.held++; continue; }
      const template = (await ctx.store.get<EmailTemplate>('template', b.templateId))?.body;
      if (!template || template.status !== 'approved' || template.approval?.version !== template.version) { summary.held++; continue; }
      if (!withinSendHours(at, zone)) { summary.deferred++; continue; }
      const authorize = authorityOf(ctx, 'broadcast', b.broadcastId, template);
      // Before it starts: a broadcast whose authority is revoked never moves to "sending".
      if ((await authorize()).state !== 'clear') { summary.held++; continue; }
      if (b.status === 'scheduled') {
        if (await ctx.store.put('broadcast', b.broadcastId, { ...b, status: 'sending' }, { expected: version }) === 'conflict') continue;
        b = { ...b, status: 'sending' }; version++;
      }
      let after: string | null = null, finished = true;
      do {
        const page: { items: { id: string; body: ContactBody }[]; after: string | null } = await ctx.store.query<ContactBody>('contact', { prefix: `${b.programKey}:`, after, limit: 100 });
        after = page.after;
        // A broadcast cancelled while it is going out stops at the next page.
        if ((await ctx.store.get<Broadcast>('broadcast', b.broadcastId))?.body.status !== 'sending') return;
        // So does one whose authority is revoked, or cannot be read, while it is going out.
        if ((await authorize()).state !== 'clear') { summary.held++; finished = false; break; }
        let stopped = false;
        for (const contact of page.items) {
          // Only people on the list when the broadcast was due; the claim makes each of them receive it once.
          if (contact.body.state !== 'confirmed' || !contact.body.confirmedAt || contact.body.confirmedAt > b.sendAt!) continue;
          if (await ctx.store.get('send', `bc:${b.broadcastId}:${contact.body.emailHash}`)) continue;
          if (budget.left <= 0) { finished = false; break; }
          budget.left--;
          const outcome = await sendOne(ctx, `bc:${b.broadcastId}:${contact.body.emailHash}`, contact.body, template, 'broadcast', summary, gap, authorize);
          if (outcome === 'cap') { summary.skipped.push({ practiceId: ctx.store.practiceId, reason: 'monthly_email_allowance_reached' }); return; }
          if (outcome === 'retry') finished = false;
          if (outcome === 'held' || outcome === 'unavailable') { finished = false; stopped = true; break; }
        }
        if (stopped) break;
      } while (after && finished);
      if (finished) {
        const current = await ctx.store.get<Broadcast>('broadcast', b.broadcastId);
        if (current?.body.status === 'sending') await ctx.store.put('broadcast', b.broadcastId, { ...current.body, status: 'sent' }, { expected: current.version });
      }
    }
  }
}

export { contactId };
