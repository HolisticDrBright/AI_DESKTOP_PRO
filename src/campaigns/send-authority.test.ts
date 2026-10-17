import { describe, expect, it, vi } from 'vitest';
import { workforceResponse, type WorkforceRequest, type WorkforceResponse } from './contract';
import { FORM_MIN_MS } from './public';
import type { PracticeStore } from './store';
import { fictionalEngine, tokenFrom } from './testing';

/**
 * Send authority: what an emergency login revocation does to email a practitioner already queued. Brandon's decision:
 * sends a compromised login scheduled or started pause until a different, currently authorized staff member reviews
 * them. Before this change the send job never read the revocation signal, so a revoked practitioner's broadcast and
 * sequence kept going out (the `failing before` cases below).
 *
 * The rule: a queued send carries the logins it rests on (whoever scheduled, started or edited it, and whoever
 * approved its email), and the job re-reads every one of them immediately before each SES call. A revoked one holds the
 * send and records why; an outage holds it for this pass only; an item with no recorded login (made before this
 * change) is held, never assumed. Fictional practices, logins and addresses only. 17:00Z is 10:00 in Los Angeles.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-admin-0001', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const COLLEAGUE = { practiceId: PRACTICE, personId: '31111111-1111-4111-8111-111111111111', subject: 'fictional-subject-colleague-0001', email: 'colleague@fictional-clinic.example', name: 'Fictional Colleague' };
const OTHER_ADMIN = { practiceId: OTHER, personId: '41111111-1111-4111-8111-111111111111', subject: 'fictional-subject-other-admin-0001', email: 'admin@other-clinic.example', name: 'Other Admin' };
const DAY = 86_400_000, HOUR = 3_600_000;
type Engine = ReturnType<typeof fictionalEngine>;
type Ask = (request: WorkforceRequest) => Promise<WorkforceResponse>;
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };

async function practice(e: Engine, who: typeof ADMIN, slug: string, domain: string) {
  const ask = await e.readyPractice({ practiceId: who.practiceId, slug, name: 'Fictional Clinic', domain, admin: who });
  const o = done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  const seq = o.sequences.find(s => s.programKey === 'longevity-program')!;
  for (const step of seq.steps) {
    const t = o.templates.find(x => x.templateId === step.templateId)!;
    done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  }
  return { ask, seq };
}
/** A practice with the welcome sequence started by the admin, and a colleague who holds the marketing role. */
async function setUp(options: Parameters<typeof fictionalEngine>[0] = {}) {
  const e = fictionalEngine(options);
  const { ask, seq } = await practice(e, ADMIN, 'fictional-clinic', 'mail.fictional-clinic.example');
  done(await ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: seq.version, status: 'active' }));
  done(await ask({ action: 'grant_role', personId: COLLEAGUE.personId, role: 'marketing', name: COLLEAGUE.name }));
  const colleague: Ask = request => e.staff.handle(COLLEAGUE, request);
  return { e, ask, colleague };
}
async function subscribe(e: Engine, email: string, slug = 'fictional-clinic') {
  const page = await e.publicSide.joinPage(slug, 'longevity-program');
  e.advance(FORM_MIN_MS + 10);
  await e.publicSide.join({ practice: slug, program: 'longevity-program', email, consent: 'yes', formToken: page!.formToken });
  expect(await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'))).toBe('confirmed');
}
const campaignMail = (e: Engine) => e.ses.outbox.filter(m => !m.subject.startsWith('Please confirm') && !m.subject.startsWith('[Test]'));
const BROADCAST_SUBJECT = 'An update about the Longevity Program';
const broadcastMail = (e: Engine) => campaignMail(e).filter(m => m.subject === BROADCAST_SUBJECT);
async function overview(ask: Ask) {
  const o = await ask({ action: 'overview' });
  if (o.action !== 'overview') throw new Error(o.action);
  return o;
}
/** A broadcast the given staff member writes, approves, test-sends and schedules for now. */
async function scheduleBroadcast(e: Engine, ask: Ask) {
  const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'October update',
    subject: BROADCAST_SUBJECT, blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, the program now offers evening consultations.' }, { type: 'button', label: 'Read about the program' }] } }));
  const t = o.templates.find(x => x.name === 'October update')!;
  done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  const b = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: t.templateId })).broadcasts.find(x => x.templateId === t.templateId)!;
  done(await ask({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
  done(await ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() }));
  return { t, b };
}
/** Runs `hook` once, inside the nth campaign email's SES call (1-based): after every check the job makes. */
function duringSend(e: Engine, n: number, hook: () => void) {
  const send = e.deps.ses.send.bind(e.deps.ses);
  let seen = 0;
  e.deps.ses.send = async email => {
    if (!email.subject.startsWith('Please confirm') && !email.subject.startsWith('[Test]') && ++seen === n) hook();
    return send(email);
  };
}
/** Replaces some of a practice store's methods for the rest of the test. */
function intercept(e: Engine, wrap: (p: PracticeStore) => Partial<PracticeStore>) {
  const practiceOf = e.deps.store.practice.bind(e.deps.store);
  e.deps.store = { global: e.deps.store.global, practice(id: string): PracticeStore {
    const p = practiceOf(id);
    const copy = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v]));
    return { ...copy, ...wrap(p) } as PracticeStore;
  } };
}
/** Runs `hook` once, right after the nth send claim is written (1-based): between the claim and SES. */
function afterClaim(e: Engine, n: number, hook: () => void) {
  let seen = 0;
  intercept(e, p => ({ put: async (kind, id, body, options) => {
    const result = await p.put(kind, id, body, options);
    if (kind === 'send' && options.expected === null && result === 'ok' && ++seen === n) hook();
    return result;
  } }));
}
const broadcastOf = async (ask: Ask, broadcastId: string) => (await overview(ask)).broadcasts.find(b => b.broadcastId === broadcastId)!;
const sequenceOf = async (ask: Ask) => (await overview(ask)).sequences.find(s => s.programKey === 'longevity-program')!;
const resumeBroadcast = (ask: Ask, broadcastId: string) => ask({ action: 'resume_held_send', target: { kind: 'broadcast', broadcastId } });
const resumeSequence = (ask: Ask) => ask({ action: 'resume_held_send', target: { kind: 'sequence', programKey: 'longevity-program' } });
/** The colleague approves every email again, so no approval rests on the revoked login. */
async function reapproveAll(colleague: Ask) {
  for (const t of (await overview(colleague)).templates.filter(x => x.status === 'approved')) done(await colleague({ action: 'approve_template', templateId: t.templateId, version: t.version }));
}

describe('a revoked login\'s queued email is held (failing before: it kept sending)', () => {
  it('revoked before a pass: the sequence sends nothing and is held for review, with the reason', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.revoke(ADMIN.subject);
    const pass = await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect(pass).toMatchObject({ sent: 0, held: 1 });
    expect((await sequenceOf(ask)).hold).toMatchObject({ reason: 'authority_revoked', persons: [ADMIN.personId] });
    // Still held a day later: a hold is a record, not a skipped pass.
    e.advance(DAY); await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
  });

  it('revoked before a pass: a scheduled broadcast sends nothing and is held', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'one@fictional.example'); await subscribe(e, 'two@fictional.example');
    await e.pass();
    const { b } = await scheduleBroadcast(e, ask);
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    expect(broadcastMail(e)).toHaveLength(0);
    expect(await broadcastOf(ask, b.broadcastId)).toMatchObject({ hold: { reason: 'authority_revoked', persons: [ADMIN.personId] } });
  });

  it('revoked during pagination: the next page sends nothing', async () => {
    const { e, ask } = await setUp();
    for (let i = 0; i < 103; i++) await subscribe(e, `person-${String(i).padStart(3, '0')}@fictional.example`);
    await e.pass(); await e.pass();
    const { b } = await scheduleBroadcast(e, ask);
    // The second page of contacts is read after the login is revoked.
    intercept(e, p => ({ query: async (kind, options) => {
      if (kind === 'contact' && options?.after) e.revocations.revoke(ADMIN.subject);
      return p.query(kind, options);
    } }));
    await e.pass();
    expect(broadcastMail(e)).toHaveLength(100);
    expect(await broadcastOf(ask, b.broadcastId)).toMatchObject({ status: 'sending', hold: { reason: 'authority_revoked' } });
    e.advance(HOUR); await e.pass();
    expect(broadcastMail(e)).toHaveLength(100);
  });

  it('revoked immediately before a send: that email is not sent, its claim and the month\'s count are given back', async () => {
    const { e, ask } = await setUp();
    for (const who of ['a', 'b', 'c']) await subscribe(e, `${who}@fictional.example`);
    await e.pass();
    await scheduleBroadcast(e, ask);
    // The second email's check runs after its claim: the revocation lands between the claim and SES.
    afterClaim(e, 2, () => e.revocations.revoke(ADMIN.subject));
    await e.pass();
    expect(broadcastMail(e)).toHaveLength(1);
    const store = e.store.practice(PRACTICE);
    const claims = (await store.query('send', { prefix: 'bc:' })).items;
    expect(claims).toHaveLength(1);
    const month = e.now().toISOString().slice(0, 7).replace('-', '');
    // Three welcome emails, one broadcast email: the held one is not counted.
    expect((await store.get<{ sent: number }>('counter', `emails-${month}`))?.body.sent).toBe(4);
  });

  it('the remaining race, stated: a revocation that lands while SES is accepting an email cannot stop that email, and stops the next', async () => {
    const { e, ask } = await setUp();
    for (const who of ['a', 'b', 'c']) await subscribe(e, `${who}@fictional.example`);
    await e.pass();
    await scheduleBroadcast(e, ask);
    duringSend(e, 2, () => e.revocations.revoke(ADMIN.subject));
    await e.pass();
    // The second email was already past its check when the revocation landed: at most one email per practice per pass.
    expect(broadcastMail(e)).toHaveLength(2);
  });

  it('revoked during a retry: an email SES refused is not sent on the retry', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.ses.next({ outcome: 'refused', detail: 'provider_unavailable' });
    await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    e.revocations.revoke(ADMIN.subject);
    e.advance(20 * 60_000); await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
  });

  it('revoked after a lost reply: the unanswered email is never sent again, before or after review, and nobody else is sent anything until review', async () => {
    const { e, ask, colleague } = await setUp();
    for (const who of ['a', 'b']) await subscribe(e, `${who}@fictional.example`);
    await e.pass();
    await scheduleBroadcast(e, ask);
    e.ses.next({ outcome: 'unknown' });
    afterClaim(e, 2, () => e.revocations.revoke(ADMIN.subject));
    await e.pass();
    // The first broadcast email had no answer (it may have gone out); the second was held.
    expect(broadcastMail(e)).toHaveLength(0);
    await reapproveAll(colleague);
    const b = (await overview(colleague)).broadcasts[0]!;
    done(await resumeBroadcast(colleague, b.broadcastId));
    await e.pass();
    expect(broadcastMail(e)).toHaveLength(1);
    e.advance(HOUR); await e.pass();
    expect(broadcastMail(e)).toHaveLength(1);
  });
});

describe('an outage or a missing signal holds, and never reads as "not revoked"', () => {
  it('the signal unreadable: nothing is sent this pass, nothing is recorded as held, and the next pass sends', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.outage(true);
    const pass = await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect(pass.held).toBe(1);
    expect((await sequenceOf(ask)).hold ?? null).toBeNull();
    e.revocations.outage(false);
    e.advance(20 * 60_000); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });

  it('a revocation still being decided (pending) holds for the pass and records nothing: declined, the sequence just resumes', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.pend(ADMIN.subject);
    expect((await e.pass()).held).toBe(1);
    expect(campaignMail(e)).toHaveLength(0);
    expect((await sequenceOf(ask)).hold ?? null).toBeNull();
    // The decision was declined, or lapsed: nothing to review, and the next pass sends.
    e.revocations.lapse(ADMIN.subject);
    e.advance(20 * 60_000); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });

  it('a pending decision that takes effect becomes a recorded hold at the next check', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.pend(ADMIN.subject);
    await e.pass();
    e.revocations.revoke(ADMIN.subject);
    e.advance(20 * 60_000); await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect((await sequenceOf(ask)).hold).toMatchObject({ reason: 'authority_revoked' });
  });

  it('no signal configured for the sender: no practice sends, and the pass says why', async () => {
    const e = fictionalEngine({ staffRevocation: 'unconfigured' });
    const { ask, seq } = await practice(e, ADMIN, 'fictional-clinic', 'mail.fictional-clinic.example');
    done(await ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: seq.version, status: 'active' }));
    await subscribe(e, 'avery@fictional.example');
    const pass = await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect(pass.skipped).toEqual([{ practiceId: PRACTICE, reason: 'staff_revocation_unconfigured' }]);
  });
});

describe('records made before send authority existed are held, never assumed', () => {
  it('a sequence started before the change (no recorded login) is held as unrecorded, and a staff edit does not make it trusted', async () => {
    const { e, ask, colleague } = await setUp();
    const store = e.store.practice(PRACTICE);
    const item = (await store.get<Record<string, unknown>>('sequence', 'longevity-program'))!;
    const { authorizedBy: _, ...legacy } = item.body;
    await store.put('sequence', 'longevity-program', legacy, { expected: item.version });
    // An edit by a staff member with a good login, before any pass: still unrecorded, so still held.
    const s = await sequenceOf(ask);
    done(await colleague({ action: 'save_sequence', programKey: 'longevity-program', expectedVersion: s.version, steps: s.steps }));
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect((await sequenceOf(ask)).hold).toMatchObject({ reason: 'authority_unrecorded' });
    // A review by a staff member with a good login resumes it.
    done(await resumeSequence(colleague));
    e.advance(2 * HOUR); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });

  it('an email approved before the change (no recorded approver login) holds the send until someone approves it again', async () => {
    const { e, ask, colleague } = await setUp();
    const store = e.store.practice(PRACTICE);
    for (const t of (await store.query<{ approval: { by: Record<string, unknown> } | null }>('template')).items) {
      if (!t.body.approval) continue;
      const { subject: _, ...by } = t.body.approval.by;
      await store.put('template', t.id, { ...t.body, approval: { ...t.body.approval, by } }, { expected: t.version });
    }
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    expect((await sequenceOf(ask)).hold).toMatchObject({ reason: 'approval_unattributed' });
    await expect(resumeSequence(colleague)).rejects.toMatchObject({ category: 'not_ready', detail: 'template_reapproval_required' });
    await reapproveAll(colleague);
    done(await resumeSequence(colleague));
    e.advance(2 * HOUR); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });
});

describe('editing, pausing and starting again by someone else', () => {
  it('does not take over: the revoked login still holds the sequence, and starting a held sequence is refused', async () => {
    const { e, ask, colleague } = await setUp();
    let s = await sequenceOf(ask);
    done(await colleague({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: s.version, status: 'paused' }));
    s = await sequenceOf(ask);
    done(await colleague({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: s.version, status: 'active' }));
    expect((await sequenceOf(ask)).authorizedBy?.map(a => a.personId)).toEqual([ADMIN.personId, COLLEAGUE.personId]);
    e.revocations.revoke(ADMIN.subject);
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    s = await sequenceOf(colleague);
    done(await colleague({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: s.version, status: 'paused' }));
    s = await sequenceOf(colleague);
    await expect(colleague({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: s.version, status: 'active' }))
      .rejects.toMatchObject({ category: 'not_ready', detail: 'held_for_review' });
  });

  it('a broadcast drafted by one person and scheduled by another rests on both', async () => {
    const { e, ask, colleague } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'October update',
      subject: BROADCAST_SUBJECT, blocks: [{ type: 'paragraph', text: 'Hello.' }, { type: 'button', label: 'Read about the program' }] } }));
    const t = o.templates.find(x => x.name === 'October update')!;
    done(await colleague({ action: 'approve_template', templateId: t.templateId, version: t.version }));
    const b = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: t.templateId })).broadcasts[0]!;
    done(await colleague({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
    done(await colleague({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() }));
    expect((await broadcastOf(ask, b.broadcastId)).authorizedBy?.map(a => [a.personId, a.action])).toEqual([[ADMIN.personId, 'edited'], [COLLEAGUE.personId, 'scheduled']]);
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    expect(broadcastMail(e)).toHaveLength(0);
  });
});

describe('the review that resumes a held send', () => {
  it('is refused to the same person, even on a new login, and to anyone without the marketing role', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    // The revoked person's replacement login (a new subject) cannot review their own queued work.
    const replacement = { ...ADMIN, subject: 'fictional-subject-admin-0002' };
    await expect(e.staff.handle(replacement, { action: 'resume_held_send', target: { kind: 'sequence', programKey: 'longevity-program' } }))
      .rejects.toMatchObject({ category: 'forbidden', detail: 'independent_reviewer_required' });
    const outsider = { practiceId: PRACTICE, personId: '51111111-1111-4111-8111-111111111111', subject: 'fictional-subject-outsider-0001', email: null };
    await expect(e.staff.handle(outsider, { action: 'resume_held_send', target: { kind: 'sequence', programKey: 'longevity-program' } }))
      .rejects.toMatchObject({ category: 'forbidden', detail: 'marketing_role_required' });
    void ask;
  });

  it('re-reads the reviewer\'s own login and fails closed when the signal cannot be read', async () => {
    const { e, colleague } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    await reapproveAll(colleague);
    e.revocations.outage(true);
    await expect(resumeSequence(colleague)).rejects.toMatchObject({ category: 'unavailable', detail: 'staff_revocation_unavailable' });
    e.revocations.outage(false);
    e.revocations.revoke(COLLEAGUE.subject);
    await expect(resumeSequence(colleague)).rejects.toMatchObject({ category: 'forbidden', detail: 'identity_refused' });
  });

  it('needs every email approved by a login that is not revoked, then resumes and is recorded once, even if the reply is lost and it is sent again', async () => {
    const { e, colleague } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    await expect(resumeSequence(colleague)).rejects.toMatchObject({ category: 'not_ready', detail: 'template_reapproval_required' });
    await reapproveAll(colleague);
    done(await resumeSequence(colleague));
    // A retry after a lost reply is the same review, not a second one.
    done(await resumeSequence(colleague));
    const s = await sequenceOf(colleague);
    expect(s.hold ?? null).toBeNull();
    expect(s.authorizedBy?.map(a => [a.personId, a.action])).toEqual([[COLLEAGUE.personId, 'reviewed']]);
    const audits = (await e.store.practice(PRACTICE).query<Record<string, unknown>>('audit')).items;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.body).toMatchObject({ contract: 'send-review/1', target: { kind: 'sequence', programKey: 'longevity-program' },
      reviewer: { personId: COLLEAGUE.personId }, previousHold: { reason: 'authority_revoked', persons: [ADMIN.personId] }, replaced: [ADMIN.personId] });
    expect(JSON.stringify(audits[0]!.body)).not.toContain(ADMIN.subject);
    e.advance(2 * HOUR); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });

  it('is refused for a send that is not held', async () => {
    const { colleague } = await setUp();
    await expect(resumeSequence(colleague)).rejects.toMatchObject({ category: 'conflict', detail: 'not_held' });
  });
});

describe('the recorded login', () => {
  it('is the verified token\'s own subject when staff act through the API, and the Campaigns screen is never sent a subject', async () => {
    const { e, ask } = await setUp();
    const exp = Math.floor(e.now().getTime() / 1000) + 3600;
    vi.useFakeTimers({ now: e.now(), toFake: ['Date'] });
    try {
      const reply = await e.http({ routeKey: 'POST /campaigns/workforce', body: JSON.stringify({ action: 'overview' }),
        requestContext: { authorizer: { jwt: { claims: { 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, sub: ADMIN.subject, exp, email: ADMIN.email } } } } });
      expect(reply.statusCode).toBe(200);
      // The Desktop route parses this strictly; it carries who acted and when, and no login subject anywhere.
      expect(() => workforceResponse.parse((JSON.parse(reply.body) as { data: unknown }).data)).not.toThrow();
      expect(reply.body).not.toContain(ADMIN.subject);
      expect(reply.body).toContain(ADMIN.personId);
    } finally { vi.useRealTimers(); }
    const stored = await e.store.practice(PRACTICE).get<{ authorizedBy: { subject: string }[] }>('sequence', 'longevity-program');
    expect(stored!.body.authorizedBy.map(a => a.subject)).toEqual([ADMIN.subject]);
    void ask;
  });
  it('a staff request without a well-formed login subject is refused before anything is read', async () => {
    const e = fictionalEngine();
    await expect(e.staff.handle({ ...ADMIN, subject: 'no' }, { action: 'overview' })).rejects.toMatchObject({ category: 'forbidden', detail: 'identity_refused' });
  });
});

describe('what a hold leaves alone', () => {
  it('unsubscribe still works while held, and nobody who left is sent anything after the review', async () => {
    const { e, colleague } = await setUp();
    for (const who of ['stays', 'leaves']) await subscribe(e, `${who}@fictional.example`);
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    // Nobody has had a campaign email yet, so unsubscribe with the token one would carry.
    const { unsubscribeToken } = await import('./workforce');
    const contacts = (await e.store.practice(PRACTICE).query<{ emailHash: string; email: string }>('contact')).items;
    const leaving = contacts.find(c => c.body.email === 'leaves@fictional.example')!;
    expect(await e.publicSide.unsubscribe(unsubscribeToken(e.deps, PRACTICE, 'longevity-program', leaving.body.emailHash, null))).toBe('unsubscribed');
    await reapproveAll(colleague);
    done(await resumeSequence(colleague));
    e.advance(2 * HOUR); await e.pass();
    expect(campaignMail(e).map(m => m.to)).toEqual(['stays@fictional.example']);
  });

  it('quiet hours still apply after a review', async () => {
    const { e, colleague } = await setUp({ start: '2026-10-16T02:00:00Z' }); // 19:00 in Los Angeles
    await subscribe(e, 'avery@fictional.example');
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    await reapproveAll(colleague);
    done(await resumeSequence(colleague));
    e.set('2026-10-16T04:00:00Z'); // 21:00
    expect((await e.pass()).deferred).toBe(1);
    expect(campaignMail(e)).toHaveLength(0);
    e.set('2026-10-16T15:00:00Z'); await e.pass(); // 08:00
    expect(campaignMail(e)).toHaveLength(1);
  });

  it('another practice\'s sends are untouched by this practice\'s revocation', async () => {
    const { e } = await setUp();
    const other = await practice(e, OTHER_ADMIN, 'other-clinic', 'mail.other-clinic.example');
    done(await other.ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: other.seq.version, status: 'active' }));
    await subscribe(e, 'here@fictional.example');
    await subscribe(e, 'there@fictional.example', 'other-clinic');
    e.revocations.revoke(ADMIN.subject);
    await e.pass();
    expect(campaignMail(e).map(m => m.to)).toEqual(['there@fictional.example']);
  });
});
