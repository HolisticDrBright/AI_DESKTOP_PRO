import { describe, expect, it } from 'vitest';
import type { WorkforceRequest, WorkforceResponse } from './contract';
import { FORM_MIN_MS } from './public';
import { fictionalEngine, tokenFrom } from './testing';

/**
 * Sending: sequence timing, never twice (a second pass, a concurrent pass, a crash after the claim), editing an active
 * sequence, broadcasts with their test send, quiet hours, pacing to the SES rate, the monthly allowance and a refused
 * send. Fictional practices and addresses only. 17:00Z on 2026-10-15 is 10:00 in Los Angeles.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const DAY = 86_400_000;
type Engine = ReturnType<typeof fictionalEngine>;
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };

async function setUp(start?: string) {
  const e = fictionalEngine({ start });
  const ask = await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  const o = done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  const seq = o.sequences.find(s => s.programKey === 'longevity-program')!;
  // Approve every welcome email (each passes the content check as written).
  for (const step of seq.steps) {
    const t = o.templates.find(x => x.templateId === step.templateId)!;
    done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  }
  done(await ask({ action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: seq.version, status: 'active' }));
  return { e, ask, seq, templates: o.templates };
}
async function subscribe(e: Engine, email: string) {
  const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
  e.advance(FORM_MIN_MS + 10);
  await e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email, consent: 'yes', formToken: page!.formToken });
  expect(await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'))).toBe('confirmed');
}
const campaignMail = (e: Engine) => e.ses.outbox.filter(m => !m.subject.startsWith('Please confirm') && !m.subject.startsWith('[Test]'));

describe('a welcome sequence', () => {
  it('starts at confirmation, sends each step after its wait, and stops at the end', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    expect(campaignMail(e).map(m => m.subject)).toEqual(['Welcome: about the Longevity Program']);
    e.advance(2 * DAY); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
    e.advance(1 * DAY); await e.pass();
    expect(campaignMail(e).map(m => m.subject)).toEqual(['Welcome: about the Longevity Program', 'How the Longevity Program is structured']);
    e.advance(4 * DAY); await e.pass();
    e.advance(30 * DAY); await e.pass();
    expect(campaignMail(e).map(m => m.subject)).toEqual(['Welcome: about the Longevity Program', 'How the Longevity Program is structured', 'Starting with a consultation']);
  });
  it('every email carries the footer, the one-click headers, and links only to the program page and the unsubscribe page', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    const mail = campaignMail(e)[0]!;
    expect(mail.text).toContain('Fictional Clinic\n100 Fictional Way, Exampletown, CA 90000');
    expect(mail.headers).toEqual([{ name: 'List-Unsubscribe', value: expect.stringMatching(/^<https:\/\/clinic\.fictional\.example\/api\/public\/campaigns\/unsubscribe\?t=[A-Za-z0-9_-]+>$/) },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }]);
    const links = new Set([...mail.html.matchAll(/href="([^"]+)"/g)].map(m => m[1]!.replace(/\?t=.*$/, '?t=…')));
    expect(links).toEqual(new Set(['https://clinic.fictional.example/learn/longevity-program?via=email', 'https://clinic.fictional.example/join/unsubscribe?t=…']));
    expect(mail.tags).toEqual(expect.arrayContaining([{ name: 'practice', value: PRACTICE }, { name: 'kind', value: 'sequence' }]));
    expect(mail.configurationSet).toBe('alp-marketing');
  });
  it('is never sent twice: a second pass, a concurrent pass and a crash after the claim all send nothing more', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await Promise.all([e.pass(), e.pass()]);
    await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
    // A crash between the claim and SES: SES gave no answer, so the email may have gone out. It is never retried.
    e.advance(3 * DAY);
    e.ses.next({ outcome: 'unknown' });
    const first = await e.pass();
    expect(first.unknown).toBe(1);
    e.advance(DAY); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
    // The next step follows its own wait from the unknown one; the unknown step itself is never sent again.
    e.advance(3 * DAY); await e.pass();
    expect(campaignMail(e).map(m => m.subject)).toEqual(['Welcome: about the Longevity Program', 'Starting with a consultation']);
  });
  it('an SES refusal releases the claim and a later pass tries again', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    e.ses.next({ outcome: 'refused', detail: 'provider_unavailable' });
    await e.pass();
    expect(campaignMail(e)).toHaveLength(0);
    e.advance(20 * 60_000); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });
  it('editing an active sequence changes only what people have not reached yet', async () => {
    const { e, ask, seq } = await setUp();
    await subscribe(e, 'early@fictional.example');
    await e.pass();
    e.advance(3 * DAY); await e.pass();          // early has had steps 1 and 2
    await subscribe(e, 'late@fictional.example');
    await e.pass();                               // late has had step 1
    // Replace step 2's email with a new approved one, and put a new step before step 1.
    const created = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'sequence', name: 'Replacement',
      subject: 'A clearer second email', blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, here is how the program is structured.' }, { type: 'button', label: 'See how it works' }] } }));
    const replacement = created.templates.find(t => t.name === 'Replacement')!;
    done(await ask({ action: 'approve_template', templateId: replacement.templateId, version: 1 }));
    const front = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'sequence', name: 'Inserted first',
      subject: 'An inserted first email', blocks: [{ type: 'paragraph', text: 'Hello.' }, { type: 'button', label: 'Read about the program' }] } })).templates.find(t => t.name === 'Inserted first')!;
    done(await ask({ action: 'approve_template', templateId: front.templateId, version: 1 }));
    const current = (await e.staff.handle(ADMIN, { action: 'overview' }));
    if (current.action !== 'overview') throw new Error();
    const steps = current.sequences.find(s => s.programKey === 'longevity-program')!;
    done(await ask({ action: 'save_sequence', programKey: 'longevity-program', expectedVersion: steps.version, steps: [
      { stepId: null, templateId: front.templateId, waitDays: 0 },
      { stepId: steps.steps[0]!.stepId, templateId: steps.steps[0]!.templateId, waitDays: 0 },
      { stepId: steps.steps[1]!.stepId, templateId: replacement.templateId, waitDays: 3 },
      { stepId: steps.steps[2]!.stepId, templateId: steps.steps[2]!.templateId, waitDays: 4 },
    ] }));
    e.advance(5 * DAY); await e.pass();
    const byTo = (to: string) => campaignMail(e).filter(m => m.to === to).map(m => m.subject);
    // Nobody receives the inserted first step: both were past it. The late subscriber gets the edited second email.
    expect(byTo('early@fictional.example')).toEqual(['Welcome: about the Longevity Program', 'How the Longevity Program is structured', 'Starting with a consultation']);
    expect(byTo('late@fictional.example')).toEqual(['Welcome: about the Longevity Program', 'A clearer second email']);
    void seq;
  });
  it('stops at once on unsubscribe', async () => {
    const { e } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    const token = tokenFrom(campaignMail(e)[0]!.text, '/join/unsubscribe');
    expect(await e.publicSide.unsubscribe(token)).toBe('unsubscribed');
    e.advance(30 * DAY); await e.pass();
    expect(campaignMail(e)).toHaveLength(1);
  });
  it('holds a step whose email is no longer approved, and sends it once it is approved again', async () => {
    const { e, ask, seq, templates } = await setUp();
    await subscribe(e, 'avery@fictional.example');
    await e.pass();
    const second = templates.find(t => t.templateId === seq.steps[1]!.templateId)!;
    const edited = done(await ask({ action: 'save_template', templateId: second.templateId, expectedVersion: second.version, draft: { programKey: 'longevity-program', kind: 'sequence', name: second.name, subject: 'Edited, awaiting approval', blocks: second.blocks } }));
    e.advance(3 * DAY);
    expect((await e.pass()).held).toBe(1);
    expect(campaignMail(e)).toHaveLength(1);
    done(await ask({ action: 'approve_template', templateId: second.templateId, version: edited.templates.find(t => t.templateId === second.templateId)!.version }));
    e.advance(2 * 3_600_000); await e.pass();
    expect(campaignMail(e).map(m => m.subject)).toEqual(['Welcome: about the Longevity Program', 'Edited, awaiting approval']);
  });
});

describe('quiet hours, pacing and the monthly allowance', () => {
  it('sends only from 08:00 to 20:00 in the practice\'s zone, then at the next 08:00', async () => {
    const { e } = await setUp('2026-10-16T05:00:00Z'); // 22:00 the evening before, Los Angeles
    await subscribe(e, 'avery@fictional.example');
    const pass = await e.pass();
    expect(pass.deferred).toBe(1);
    expect(campaignMail(e)).toHaveLength(0);
    e.set('2026-10-16T14:59:00Z'); await e.pass();   // 07:59 local
    expect(campaignMail(e)).toHaveLength(0);
    e.set('2026-10-16T15:00:00Z'); await e.pass();   // 08:00 local
    expect(campaignMail(e)).toHaveLength(1);
  });
  it('paces each send to the account\'s SES rate', async () => {
    const { e } = await setUp();
    const pauses: number[] = [];
    e.deps.pause = async ms => { pauses.push(ms); };
    const { createSendJob } = await import('./send-job');
    for (const who of ['a', 'b', 'c']) await subscribe(e, `${who}@fictional.example`);
    await createSendJob(e.deps)();
    expect(pauses).toEqual([72, 72, 72]); // 14 per second
  });
  it('the monthly email allowance stops sending for that practice and says why', async () => {
    const { e } = await setUp();
    await e.operator.loadAllowances({ version: 'fictional-small', tiers: { addon: { contacts: 100, emailsPerMonth: 2 }, growth: { contacts: 100, emailsPerMonth: 2 }, complete: { contacts: 100, emailsPerMonth: 2 } } });
    for (const who of ['a', 'b', 'c']) await subscribe(e, `${who}@fictional.example`);
    const pass = await e.pass();
    expect(campaignMail(e)).toHaveLength(2);
    expect(pass.skipped).toEqual([{ practiceId: PRACTICE, reason: 'monthly_email_allowance_reached' }]);
  });
});

describe('a broadcast', () => {
  async function broadcastReady(e: Engine, ask: (r: WorkforceRequest) => Promise<WorkforceResponse>) {
    const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'October update',
      subject: 'An update about the Longevity Program', blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, the program now offers evening consultations.' }, { type: 'button', label: 'Read about the program' }] } }));
    const t = o.templates.find(x => x.name === 'October update')!;
    const b = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: t.templateId })).broadcasts[0]!;
    return { t, b };
  }
  it('needs an approved email and a test send of that exact version before it can be scheduled', async () => {
    const { e, ask } = await setUp();
    const { t, b } = await broadcastReady(e, ask);
    await expect(ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() })).rejects.toMatchObject({ detail: 'template_not_approved' });
    done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
    await expect(ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() })).rejects.toMatchObject({ detail: 'test_send_required' });
    done(await ask({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
    expect(e.ses.outbox.at(-1)).toMatchObject({ to: 'admin@fictional-clinic.example', subject: '[Test] An update about the Longevity Program' });
    const scheduled = done(await ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() }));
    expect(scheduled.broadcasts[0]!.status).toBe('scheduled');
  });
  it('goes once to each person confirmed before it was due, then is marked sent', async () => {
    const { e, ask } = await setUp();
    await subscribe(e, 'one@fictional.example'); await subscribe(e, 'two@fictional.example');
    await e.pass(); // welcome emails
    const { t, b } = await broadcastReady(e, ask);
    done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
    done(await ask({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
    done(await ask({ action: 'schedule_broadcast', broadcastId: b.broadcastId, sendAt: e.now().toISOString() }));
    e.advance(60_000);
    await subscribe(e, 'later@fictional.example');
    await e.pass(); await e.pass();
    const broadcastMail = campaignMail(e).filter(m => m.subject === 'An update about the Longevity Program');
    expect(broadcastMail.map(m => m.to).sort()).toEqual(['one@fictional.example', 'two@fictional.example']);
    const o = await e.staff.handle(ADMIN, { action: 'overview' });
    if (o.action !== 'overview') throw new Error();
    expect(o.broadcasts[0]!.status).toBe('sent');
    expect(o.results.find(r => r.templateId === t.templateId)).toMatchObject({ sent: 2, opened: null, clicked: null });
  });
});
