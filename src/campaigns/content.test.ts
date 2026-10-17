import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_PROGRAMS, type WorkforceResponse } from './contract';
import { draftProblems, renderEmail, templateProblems } from './content';
import { renderStarterMarkdown, STARTER_SEQUENCES, starterTemplate, starterWaits } from './starter-content';
import { fictionalEngine } from './testing';

/**
 * The content check (the funnel rules reused), the approval rules (a named staff member, the exact version, the
 * practice's footer, the attorney's sign-off where required), the renderer, and the starter drafts and their
 * reviewable file. Fictional only.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };
const draft = (text: string, extra: { subject?: string; button?: boolean } = {}) => ({
  subject: extra.subject ?? 'About the program', blocks: [{ type: 'paragraph' as const, text }, ...(extra.button === false ? [] : [{ type: 'button' as const, label: 'Read about the program' }])],
});

describe('the content check', () => {
  it('refuses what the funnel rules refuse, plus a treatment claim', () => {
    for (const [text, problem] of [
      ['This program will cure your fatigue.', 'no claim to cure, reverse or guarantee'],
      ['Results are guaranteed.', 'no claim to cure, reverse or guarantee'],
      ['Lose 20 lbs in a month.', 'no promised amount of change'],
      ['Ask about semaglutide.', 'no drug or brand name in an email'],
      ['Take 500 mg daily.', 'no dose in an email'],
      ['Visit www.fictional.example today.', 'no address of any kind in email'],
      ['We treat insulin resistance.', 'no drug or brand name in an email'],
      ['This approach heals the gut.', 'no claim to treat or heal'],
      ['Live longer with us.', 'no claim of added years or reversed age'],
    ] as const) expect(draftProblems(draft(text)), text).toContain(problem);
    expect(draftProblems(draft('Results are not guaranteed, and differ from person to person.'))).toEqual([]);
  });
  it('allows the first name only, refuses any other merge field or an unfilled slot, and needs a button', () => {
    expect(draftProblems(draft('Hello {{first_name}}, and {{first_name|friend}}.'))).toEqual([]);
    expect(draftProblems(draft('Hello {{program}}.'))).toContain('only the first name may be filled in from the reader');
    expect(draftProblems(draft('Hello {% if x %}.'))).toContain('only the first name may be filled in from the reader');
    expect(draftProblems(draft('[[UPDATE: write me]]'))).toContain('an unfilled [[…]] slot');
    expect(draftProblems(draft('Hello.', { button: false }))).toContain('no button to the program page');
  });
  it('blocks approval while the practice has no sender name or mailing address for the footer', () => {
    expect(templateProblems(draft('Hello.'), { senderName: null, mailingAddress: null })).toEqual([
      'the practice has no sender name, which every footer carries', 'the practice has no mailing address, which every footer carries']);
  });
});

describe('approval', () => {
  async function practice(attorney: boolean) {
    const e = fictionalEngine();
    const ask = await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    if (attorney) await e.operator.setAttorneySignoffPrograms(PRACTICE, ['weight-loss-program', 'diabetes-program']);
    return { e, ask };
  }
  it('is a named staff member\'s, for the exact version; any edit makes a new version back in draft', async () => {
    const { ask } = await practice(false);
    let o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Note', ...draft('Hello {{first_name|there}}.') } }));
    const t = o.templates[0]!;
    expect(t).toMatchObject({ status: 'draft', version: 1, approval: null });
    await expect(ask({ action: 'approve_template', templateId: t.templateId, version: 2 })).rejects.toMatchObject({ category: 'conflict' });
    o = done(await ask({ action: 'approve_template', templateId: t.templateId, version: 1 }));
    expect(o.templates[0]).toMatchObject({ status: 'approved', approval: { version: 1, by: { personId: ADMIN.personId, name: 'Fictional Admin' }, attorney: null } });
    o = done(await ask({ action: 'save_template', templateId: t.templateId, expectedVersion: 1, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Note', ...draft('Hello again.') } }));
    expect(o.templates[0]).toMatchObject({ status: 'draft', version: 2, approval: null });
  });
  it('is blocked by the content check, with the reason', async () => {
    const { ask } = await practice(false);
    const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Bad', ...draft('This will cure you.') } }));
    const t = o.templates[0]!;
    const check = await ask({ action: 'check_template', templateId: t.templateId });
    expect(check).toEqual({ action: 'check_template', templateId: t.templateId, problems: ['no claim to cure, reverse or guarantee'] });
    await expect(ask({ action: 'approve_template', templateId: t.templateId, version: 1 })).rejects.toMatchObject({ category: 'not_ready', detail: 'no claim to cure, reverse or guarantee' });
  });
  it('for a program marked so (Brandon\'s weight loss and diabetes emails), needs the attorney\'s sign-off on that exact version', async () => {
    const { ask } = await practice(true);
    const o = done(await ask({ action: 'install_starter', programKey: 'weight-loss-program' }));
    const t = o.templates.find(x => x.name === 'Welcome 1')!;
    await expect(ask({ action: 'approve_template', templateId: t.templateId, version: t.version })).rejects.toMatchObject({ detail: 'attorney_signoff_required' });
    done(await ask({ action: 'record_attorney_signoff', templateId: t.templateId, version: t.version, attorneyName: 'Fictional Counsel' }));
    const approved = done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version })).templates.find(x => x.templateId === t.templateId)!;
    expect(approved.approval).toMatchObject({ attorney: { name: 'Fictional Counsel' } });
    // The longevity emails of the same practice need no sign-off.
    const longevity = done(await ask({ action: 'install_starter', programKey: 'longevity-program' })).templates.find(x => x.programKey === 'longevity-program' && x.name === 'Welcome 1')!;
    done(await ask({ action: 'approve_template', templateId: longevity.templateId, version: longevity.version }));
  });
  it('needs the marketing role; counts are visible to any staff member, addresses are not', async () => {
    const { e, ask } = await practice(false);
    const staff = { practiceId: PRACTICE, personId: '31111111-1111-4111-8111-111111111111', subject: 'fictional-subject-31111111-1111-4111-8111-111111111111', email: 'staff@fictional-clinic.example' };
    const o = await e.staff.handle(staff, { action: 'overview' });
    expect(o).toMatchObject({ action: 'overview', role: 'none' });
    await expect(e.staff.handle(staff, { action: 'contacts', programKey: 'longevity-program' })).rejects.toMatchObject({ category: 'forbidden' });
    await expect(e.staff.handle(staff, { action: 'install_starter', programKey: 'longevity-program' })).rejects.toMatchObject({ category: 'forbidden' });
    done(await ask({ action: 'grant_role', personId: staff.personId, role: 'marketing', name: 'Fictional Staff' }));
    expect((await e.staff.handle(staff, { action: 'contacts', programKey: 'longevity-program' })).action).toBe('contacts');
    await expect(e.staff.handle(staff, { action: 'grant_role', personId: ADMIN.personId, role: 'marketing', name: 'X Y' })).rejects.toMatchObject({ detail: 'marketing_admin_required' });
  });
  it('without the marketing entitlement the screen says so and nothing can be edited or sent', async () => {
    const { e, ask } = await practice(false);
    await e.operator.revokeMarketing(PRACTICE, 'fictional-operator');
    const o = await ask({ action: 'overview' });
    expect(o).toMatchObject({ action: 'overview', entitlement: { marketing: false } });
    if (o.action === 'overview') expect(o.readiness.missing).toContain('The practice does not hold the marketing package.');
    await expect(ask({ action: 'install_starter', programKey: 'longevity-program' })).rejects.toMatchObject({ category: 'not_entitled' });
  });
});

describe('rendering', () => {
  it('escapes text, fills only the first name, and builds the footer from the practice\'s settings', () => {
    const r = renderEmail({ programKey: 'diabetes-program', subject: 'For {{first_name|you}}', blocks: [{ type: 'heading', text: '<b>Hi</b> {{first_name}}' }, { type: 'button', label: 'Read' }] },
      { settings: { senderName: 'Fictional Clinic', mailingAddress: '100 Fictional Way' }, siteOrigin: 'https://clinic.fictional.example', firstName: null,
        unsubscribeUrl: 'https://clinic.fictional.example/join/unsubscribe?t=x', oneClickUrl: 'https://clinic.fictional.example/api/public/campaigns/unsubscribe?t=x' });
    expect(r.subject).toBe('For you');
    expect(r.html).toContain('&lt;b&gt;Hi&lt;/b&gt; there');
    expect(r.html).toContain('href="https://clinic.fictional.example/learn/diabetes-program?via=email"');
    expect(r.text).toContain('You are receiving this because you asked Fictional Clinic for email updates about the diabetes program.');
    expect(() => renderEmail({ programKey: 'diabetes-program', subject: 's', blocks: [] }, { settings: { senderName: null, mailingAddress: 'x' }, siteOrigin: 'https://clinic.fictional.example', firstName: null, unsubscribeUrl: 'u', oneClickUrl: 'u' })).toThrow('footer_incomplete');
  });
});

describe('the starter drafts', () => {
  it('for each program: three welcome emails that pass the check, and a broadcast that cannot be approved until its slot is written', () => {
    expect(STARTER_SEQUENCES.map(s => s.program)).toEqual([...CAMPAIGN_PROGRAMS]);
    for (const sequence of STARTER_SEQUENCES) {
      expect(starterWaits(sequence)).toEqual([0, 3, 4]);
      for (const email of sequence.emails) {
        const problems = draftProblems(starterTemplate(sequence.program, email));
        if (email.kind === 'welcome') expect(problems, email.id).toEqual([]);
        else expect(problems, email.id).toEqual(['an unfilled [[…]] slot']);
      }
    }
  });
  it('the reviewable file is exactly what the source produces (UPDATE_CAMPAIGN_DRAFTS=1 rewrites it)', () => {
    const path = 'docs/campaign-starter-sequences-DRAFT-2026-10-15.md';
    if (process.env.UPDATE_CAMPAIGN_DRAFTS === '1') writeFileSync(path, renderStarterMarkdown());
    const file = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    expect(file).toBe(renderStarterMarkdown());
  });
});
