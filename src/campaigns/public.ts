import { CAMPAIGN_CONSENT_VERSION, CAMPAIGN_PROGRAM_LABEL, campaignProgram, consentLine, emailAddress, firstName as firstNameSchema, JOIN_ACCEPTED, joinSubmission, practiceSlug,
  type CampaignProgram, type ConfirmOutcome, type JoinPageInfo } from './contract';
import { confirmationEmail } from './content';
import { CampaignError, contactId, DAY_MS, loadPractice, stateChangeOps, type ContactBody, type EngineDeps, type PracticeContext } from './practice-context';
import { tenantNameFor } from './ses';
import type { TransactOp } from './store';
import { addressHash, seal, unseal } from './tokens';

/**
 * The public side: the sign-up page, the sign-up itself, confirmation and unsubscribe. Each is unauthenticated,
 * accepts only its fixed fields, and gives the same answer whether or not an address is already on a list.
 *
 * Bot protection uses no third-party script: a hidden field and a sealed form time (too fast or too old does
 * nothing), with double opt-in as the real guard. Rate ceilings per practice per hour and per address per day do
 * nothing visible either: the answer is always "check your email".
 */
export const CONFIRM_LINK_MS = 48 * 3_600_000;
export const UNCONFIRMED_KEPT_MS = 7 * DAY_MS;
export const FORM_MIN_MS = 3_000, FORM_MAX_MS = DAY_MS;
export const PRACTICE_HOURLY_SIGNUPS = 300, ADDRESS_DAILY_SIGNUPS = 3;

export function createPublicCampaigns(deps: EngineDeps) {
  const now = () => deps.now?.() ?? new Date();
  const enabled = () => { if (!deps.config.enabled) throw new CampaignError('disabled'); };

  /** A practice that can take a sign-up for this program right now, or null (the page then does not exist). */
  async function openPractice(slug: string, program: string): Promise<{ ctx: PracticeContext; program: CampaignProgram } | null> {
    if (!practiceSlug.safeParse(slug).success || !campaignProgram.safeParse(program).success) return null;
    const index = await deps.store.global.get<{ practiceId: string }>('slug', slug);
    if (!index) return null;
    const ctx = await loadPractice(deps, index.body.practiceId);
    if (!ctx.readiness.canSend || ctx.settings.joinSlug !== slug) return null;
    return { ctx, program: program as CampaignProgram };
  }

  return {
    async joinPage(slug: string, program: string): Promise<JoinPageInfo | null> {
      enabled();
      const open = await openPractice(slug, program);
      if (!open) return null;
      const practiceName = open.ctx.settings.senderName!, label = CAMPAIGN_PROGRAM_LABEL[open.program];
      return { practiceName, programKey: open.program, programLabel: label, consentVersion: CAMPAIGN_CONSENT_VERSION, consentLine: consentLine(practiceName, label),
        formToken: seal(deps.keys, 'join-form', { s: slug, k: open.program, i: now().getTime() }) };
    },

    /** Whether a program page may show "Get updates", and where it leads. */
    async signupOpen(slug: string, program: string): Promise<boolean> {
      if (!deps.config.enabled) return false;
      return (await openPractice(slug, program)) !== null;
    },

    async join(raw: unknown): Promise<typeof JOIN_ACCEPTED> {
      enabled();
      const parsed = joinSubmission.safeParse(raw);
      if (!parsed.success) throw new CampaignError('invalid', 'form_incomplete');
      const submission = parsed.data;
      const email = emailAddress.safeParse(submission.email);
      if (!email.success) throw new CampaignError('invalid', 'email_invalid');
      const name = submission.firstName?.trim() ? firstNameSchema.safeParse(submission.firstName) : null;
      if (name && !name.success) throw new CampaignError('invalid', 'first_name_invalid');
      // From here on the answer is the same whatever happens.
      if (submission.website?.trim()) return JOIN_ACCEPTED;
      const form = unseal<{ s?: string; k?: string; i?: number }>(deps.keys, 'join-form', submission.formToken);
      const at = now().getTime();
      if (!form || form.s !== submission.practice || form.k !== submission.program || typeof form.i !== 'number' || at - form.i < FORM_MIN_MS || at - form.i > FORM_MAX_MS) return JOIN_ACCEPTED;
      const open = await openPractice(submission.practice, submission.program);
      if (!open) return JOIN_ACCEPTED;
      const { ctx, program } = open;
      const hash = addressHash(deps.keys, email.data);
      const hour = new Date(at).toISOString().slice(0, 13).replace(/\D/g, ''), day = hour.slice(0, 8);
      if (!await ctx.store.increment('rate', `hour-${hour}`, 'n', 1, PRACTICE_HOURLY_SIGNUPS)) return JOIN_ACCEPTED;
      if (!await ctx.store.increment('rate', `address-${hash}-${day}`, 'n', 1, ADDRESS_DAILY_SIGNUPS)) return JOIN_ACCEPTED;
      if (await ctx.store.get('suppression', hash)) return JOIN_ACCEPTED;
      const id = contactId(program, hash);
      const existing = await ctx.store.get<ContactBody>('contact', id);
      if (existing?.body.state === 'confirmed' || existing?.body.state === 'bounced' || existing?.body.state === 'complained') return JOIN_ACCEPTED;
      const iso = new Date(at).toISOString();
      const body: ContactBody = { programKey: program, emailHash: hash, email: email.data, firstName: name?.success ? name.data : null, state: 'pending',
        consentVersion: CAMPAIGN_CONSENT_VERSION, createdAt: existing?.body.createdAt ?? iso, confirmedAt: null, stateAt: iso, enrollment: null };
      const ops: TransactOp[] = [{ op: 'put', kind: 'contact', id, body, expected: existing?.version ?? null, dueAt: null, expiresAt: Math.floor((at + UNCONFIRMED_KEPT_MS) / 1000) },
        ...stateChangeOps(program, existing?.body.state ?? null, 'pending')];
      if (!await ctx.store.transact(ops)) return JOIN_ACCEPTED;
      const token = seal(deps.keys, 'confirm', { p: ctx.store.practiceId, k: program, h: hash, x: at + CONFIRM_LINK_MS });
      const message = confirmationEmail({ practiceName: ctx.settings.senderName!, program, mailingAddress: ctx.settings.mailingAddress!,
        confirmUrl: `${new URL(deps.config.siteOrigin).origin}/join/confirm?t=${token}` });
      await deps.ses.send({ from: `${ctx.settings.senderName} <${deps.config.fromLocalPart}@${ctx.settings.sendingDomain}>`, to: email.data, ...message, headers: [],
        configurationSet: deps.config.configurationSet, tenant: tenantNameFor(ctx.store.practiceId),
        tags: [{ name: 'practice', value: ctx.store.practiceId }, { name: 'kind', value: 'confirm' }, { name: 'program', value: program }, { name: 'contact', value: hash }] });
      return JOIN_ACCEPTED;
    },

    async confirm(token: string): Promise<ConfirmOutcome> {
      enabled();
      const t = unseal<{ p?: string; k?: string; h?: string; x?: number }>(deps.keys, 'confirm', token);
      if (!t || typeof t.p !== 'string' || typeof t.h !== 'string' || typeof t.x !== 'number' || !campaignProgram.safeParse(t.k).success) return 'invalid';
      const at = now();
      if (t.x < at.getTime()) return 'expired';
      const program = t.k as CampaignProgram;
      let ctx: PracticeContext;
      try { ctx = await loadPractice(deps, t.p); } catch { return 'invalid'; }
      if (!ctx.entitlement?.marketing) return 'unavailable';
      if (!ctx.allowance) return 'unavailable';
      for (let attempt = 0; attempt < 3; attempt++) {
        const contact = await ctx.store.get<ContactBody>('contact', contactId(program, t.h));
        if (!contact) return 'expired';
        if (contact.body.state === 'confirmed') return 'confirmed';
        if (contact.body.state !== 'pending') return 'invalid';
        const address = await ctx.store.get<{ active: number }>('address', t.h);
        const sequence = await ctx.store.get<{ status: string; version: number; steps: { stepId: string; waitDays: number }[] }>('sequence', program);
        const iso = at.toISOString();
        const enrolled = sequence?.body.status === 'active' && sequence.body.steps.length > 0;
        const body: ContactBody = { ...contact.body, state: 'confirmed', confirmedAt: iso, stateAt: iso,
          enrollment: enrolled ? { sequenceVersion: sequence!.body.version, anchorAt: iso, sentStepIds: [], lastSentStepId: null, lastSentPosition: -1, lastSentAt: null } : null };
        const dueAt = enrolled ? new Date(at.getTime() + sequence!.body.steps[0]!.waitDays * DAY_MS).toISOString() : null;
        const firstList = (address?.body.active ?? 0) === 0;
        const ops: TransactOp[] = [
          { op: 'put', kind: 'contact', id: contactId(program, t.h), body, expected: contact.version, dueAt, expiresAt: null },
          { op: 'put', kind: 'address', id: t.h, body: { active: (address?.body.active ?? 0) + 1 }, expected: address?.version ?? null },
          ...stateChangeOps(program, 'pending', 'confirmed'),
          // A new address counts against the practice's contact allowance; reaching it refuses, never drops anyone.
          ...(firstList ? [{ op: 'increment' as const, kind: 'counter' as const, id: 'contacts', field: 'confirmed', by: 1, max: ctx.allowance.contacts }] : []),
        ];
        if (await ctx.store.transact(ops)) return 'confirmed';
        const counter = await ctx.store.get<{ confirmed?: number }>('counter', 'contacts');
        if (firstList && (counter?.body.confirmed ?? 0) >= ctx.allowance.contacts) return 'list_full';
      }
      return 'unavailable';
    },

    /** One click: the footer link and the RFC 8058 POST both land here, and it takes effect at once. */
    async unsubscribe(token: string): Promise<'unsubscribed' | 'invalid'> {
      enabled();
      const t = unseal<{ p?: string; k?: string; h?: string; t?: string }>(deps.keys, 'unsubscribe', token);
      if (!t || typeof t.p !== 'string' || typeof t.h !== 'string' || !campaignProgram.safeParse(t.k).success) return 'invalid';
      const program = t.k as CampaignProgram;
      let store;
      try { store = deps.store.practice(t.p); } catch { return 'invalid'; }
      for (let attempt = 0; attempt < 3; attempt++) {
        const contact = await store.get<ContactBody>('contact', contactId(program, t.h));
        if (!contact || contact.body.state === 'unsubscribed' || contact.body.state === 'bounced' || contact.body.state === 'complained') return 'unsubscribed';
        const ops = await leaveListOps(store, program, t.h, contact, 'unsubscribed', now().toISOString());
        if (await store.transact(ops)) {
          if (typeof t.t === 'string' && /^[0-9a-f-]{36}$/.test(t.t) && contact.body.state === 'confirmed') await store.increment('result', t.t, 'unsubscribed', 1);
          return 'unsubscribed';
        }
      }
      throw new CampaignError('unavailable');
    },
  };
}

/** The writes that take a contact off a list: its state, the list counters, and the address's place in the allowance. */
export async function leaveListOps(store: import('./store').PracticeStore, program: CampaignProgram, hash: string, contact: { version: number; body: ContactBody }, to: 'unsubscribed' | 'bounced' | 'complained', iso: string): Promise<TransactOp[]> {
  const ops: TransactOp[] = [
    { op: 'put', kind: 'contact', id: contactId(program, hash), body: { ...contact.body, state: to, stateAt: iso, enrollment: null }, expected: contact.version, dueAt: null, expiresAt: null },
    ...stateChangeOps(program, contact.body.state, to),
  ];
  if (contact.body.state === 'confirmed') {
    const address = await store.get<{ active: number }>('address', hash);
    const active = Math.max(0, (address?.body.active ?? 1) - 1);
    if (address) ops.push({ op: 'put', kind: 'address', id: hash, body: { active }, expected: address.version });
    if (active === 0) ops.push({ op: 'increment', kind: 'counter', id: 'contacts', field: 'confirmed', by: -1 });
  }
  return ops;
}
