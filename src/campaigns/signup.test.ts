import { describe, expect, it } from 'vitest';
import { JOIN_ACCEPTED } from './contract';
import { CONFIRM_LINK_MS, FORM_MIN_MS, UNCONFIRMED_KEPT_MS } from './public';
import { fictionalEngine, tokenFrom } from './testing';
import { addressHash } from './tokens';

/**
 * Getting on a list: the sign-up page, the sign-up, the confirmation and its expiry, the contact allowance, the
 * entitlement gate, and unsubscribe by link and by one-click POST. Fictional practices and addresses only.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const ready = (e: ReturnType<typeof fictionalEngine>, extra: Partial<Parameters<typeof e.readyPractice>[0]> = {}) =>
  e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN, ...extra });
async function signUp(e: ReturnType<typeof fictionalEngine>, email: string, extra: Record<string, unknown> = {}) {
  const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
  if (!page) throw new Error('no page');
  e.advance(FORM_MIN_MS + 1000);
  return e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email, firstName: 'Avery', consent: 'yes', formToken: page.formToken, ...extra });
}
const overview = async (e: ReturnType<typeof fictionalEngine>) => {
  const o = await e.staff.handle(ADMIN, { action: 'overview' });
  if (o.action !== 'overview') throw new Error('overview');
  return o;
};

describe('the sign-up page', () => {
  it('exists only for a practice that holds the marketing package and can send', async () => {
    const e = fictionalEngine();
    expect(await e.publicSide.joinPage('fictional-clinic', 'longevity-program')).toBeNull();
    await ready(e);
    const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
    expect(page).toMatchObject({ practiceName: 'Fictional Clinic', programKey: 'longevity-program', consentVersion: 'campaign-consent/1' });
    expect(page!.consentLine).toContain('I can stop at any time');
    expect(await e.publicSide.joinPage('fictional-clinic', 'not-a-program')).toBeNull();
    expect(await e.publicSide.joinPage('another-clinic', 'longevity-program')).toBeNull();
    await e.operator.revokeMarketing(PRACTICE, 'fictional-operator');
    expect(await e.publicSide.joinPage('fictional-clinic', 'longevity-program')).toBeNull();
  });
  it('switched off, the engine answers nothing at all', async () => {
    const e = fictionalEngine({ config: { enabled: false } });
    await expect(e.publicSide.joinPage('fictional-clinic', 'longevity-program')).rejects.toMatchObject({ category: 'disabled' });
    await expect(e.publicSide.join({})).rejects.toMatchObject({ category: 'disabled' });
    expect(await e.publicSide.signupOpen('fictional-clinic', 'longevity-program')).toBe(false);
    expect((await e.pass()).sent).toBe(0);
  });
});

describe('signing up', () => {
  it('sends one confirmation email and nothing else, from the practice\'s domain through the marketing set and tenant', async () => {
    const e = fictionalEngine(); await ready(e);
    expect(await signUp(e, 'Avery@Fictional.example')).toEqual(JOIN_ACCEPTED);
    expect(e.ses.outbox).toHaveLength(1);
    const mail = e.ses.outbox[0]!;
    expect(mail).toMatchObject({ to: 'avery@fictional.example', from: 'Fictional Clinic <updates@mail.fictional-clinic.example>', configurationSet: 'alp-marketing', tenant: 'alp-practice-11111111111141118111111111111111' });
    expect(mail.subject).toBe('Please confirm: updates about the Longevity Program');
    expect(mail.text).toContain('Nothing more will be sent unless you confirm');
    expect(mail.text).toMatch(/https:\/\/clinic\.fictional\.example\/join\/confirm\?t=/);
    expect((await overview(e)).lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(0);
  });
  it('answers the same whether the address is new, waiting, confirmed, refused by a check, or a bot', async () => {
    const e = fictionalEngine(); await ready(e);
    expect(await signUp(e, 'one@fictional.example')).toEqual(JOIN_ACCEPTED);
    expect(await signUp(e, 'one@fictional.example')).toEqual(JOIN_ACCEPTED);
    expect(await signUp(e, 'two@fictional.example', { website: 'https://spam.example' })).toEqual(JOIN_ACCEPTED);
    const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
    // Submitted too quickly after the page was drawn: nothing happens, the same answer.
    expect(await e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email: 'three@fictional.example', consent: 'yes', formToken: page!.formToken })).toEqual(JOIN_ACCEPTED);
    // A form token for another program or practice does nothing.
    e.advance(FORM_MIN_MS + 10);
    expect(await e.publicSide.join({ practice: 'fictional-clinic', program: 'diabetes-program', email: 'four@fictional.example', consent: 'yes', formToken: page!.formToken })).toEqual(JOIN_ACCEPTED);
    expect(e.ses.outbox.map(m => m.to)).toEqual(['one@fictional.example', 'one@fictional.example']);
  });
  it('refuses a missing consent, a malformed address or a first name that is free text, before anything happens', async () => {
    const e = fictionalEngine(); await ready(e);
    await expect(signUp(e, 'x@fictional.example', { consent: 'no' })).rejects.toMatchObject({ category: 'invalid' });
    await expect(signUp(e, 'not an address')).rejects.toMatchObject({ category: 'invalid', detail: 'email_invalid' });
    await expect(signUp(e, 'x@fictional.example', { firstName: 'Avery, please call me about my diabetes' })).rejects.toMatchObject({ category: 'invalid' });
    await expect(signUp(e, 'x@fictional.example', { phone: '+15555550101' })).rejects.toMatchObject({ category: 'invalid' });
    expect(e.ses.outbox).toEqual([]);
  });
  it('limits sign-ups per address per day without saying so', async () => {
    const e = fictionalEngine(); await ready(e);
    for (let i = 0; i < 5; i++) expect(await signUp(e, 'busy@fictional.example')).toEqual(JOIN_ACCEPTED);
    expect(e.ses.outbox).toHaveLength(3);
  });
});

describe('confirming', () => {
  it('puts the address on the list only after the click, and the click is idempotent', async () => {
    const e = fictionalEngine(); await ready(e);
    await signUp(e, 'avery@fictional.example');
    const token = tokenFrom(e.ses.outbox[0]!.text, '/join/confirm');
    expect(await e.publicSide.confirm(token)).toBe('confirmed');
    expect(await e.publicSide.confirm(token)).toBe('confirmed');
    const o = await overview(e);
    expect(o.lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(1);
    expect(o.entitlement.confirmedContacts).toBe(1);
  });
  it('the link expires after 48 hours, and an unconfirmed address is deleted after 7 days', async () => {
    const e = fictionalEngine(); await ready(e);
    await signUp(e, 'late@fictional.example');
    const token = tokenFrom(e.ses.outbox[0]!.text, '/join/confirm');
    e.advance(CONFIRM_LINK_MS + 1000);
    expect(await e.publicSide.confirm(token)).toBe('expired');
    const store = e.store.practice(PRACTICE);
    expect((await store.query('contact')).items).toHaveLength(1);
    e.advance(UNCONFIRMED_KEPT_MS);
    expect((await store.query('contact')).items).toHaveLength(0);
  });
  it('refuses a token that was tampered with, or one made for unsubscribing', async () => {
    const e = fictionalEngine(); await ready(e);
    await signUp(e, 'avery@fictional.example');
    const token = tokenFrom(e.ses.outbox[0]!.text, '/join/confirm');
    expect(await e.publicSide.confirm(token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA'))).toBe('invalid');
    expect(await e.publicSide.unsubscribe(token)).toBe('invalid');
  });
  it('reaching the contact allowance refuses new confirmations with a clear outcome, and never drops anyone already on a list', async () => {
    const e = fictionalEngine(); await ready(e);
    await e.operator.loadAllowances({ version: 'fictional-tiny', tiers: { addon: { contacts: 2, emailsPerMonth: 100 }, growth: { contacts: 2, emailsPerMonth: 100 }, complete: { contacts: 2, emailsPerMonth: 100 } } });
    for (const who of ['a', 'b', 'c']) await signUp(e, `${who}@fictional.example`);
    const tokens = e.ses.outbox.map(m => tokenFrom(m.text, '/join/confirm'));
    expect(await e.publicSide.confirm(tokens[0]!)).toBe('confirmed');
    expect(await e.publicSide.confirm(tokens[1]!)).toBe('confirmed');
    expect(await e.publicSide.confirm(tokens[2]!)).toBe('list_full');
    const o = await overview(e);
    expect(o.entitlement).toMatchObject({ contactAllowance: 2, confirmedContacts: 2 });
    expect(o.lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(2);
    // The same address on a second list does not use a second place in the allowance.
    const page = await e.publicSide.joinPage('fictional-clinic', 'diabetes-program');
    e.advance(FORM_MIN_MS + 10);
    await e.publicSide.join({ practice: 'fictional-clinic', program: 'diabetes-program', email: 'a@fictional.example', consent: 'yes', formToken: page!.formToken });
    expect(await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'))).toBe('confirmed');
    expect((await overview(e)).entitlement.confirmedContacts).toBe(2);
  });
  it('without the allowance data loaded nothing is confirmed: the operator has not finished setting the practice up', async () => {
    const e = fictionalEngine(); await ready(e);
    await signUp(e, 'avery@fictional.example');
    const token = tokenFrom(e.ses.outbox[0]!.text, '/join/confirm');
    const current = await e.store.global.get('allowances', 'current');
    await e.store.global.delete('allowances', 'current', current!.version);
    expect(await e.publicSide.confirm(token)).toBe('unavailable');
  });
});

describe('unsubscribing', () => {
  async function onList(e: ReturnType<typeof fictionalEngine>) {
    await signUp(e, 'avery@fictional.example');
    await e.publicSide.confirm(tokenFrom(e.ses.outbox[0]!.text, '/join/confirm'));
  }
  it('takes effect at once from the link, counts it, and frees the place in the allowance', async () => {
    const e = fictionalEngine(); await ready(e); await onList(e);
    const hash = addressHash(e.deps.keys, 'avery@fictional.example');
    const { unsubscribeToken } = await import('./workforce');
    const token = unsubscribeToken(e.deps, PRACTICE, 'longevity-program', hash, null);
    expect(await e.publicSide.unsubscribe(token)).toBe('unsubscribed');
    expect(await e.publicSide.unsubscribe(token)).toBe('unsubscribed');
    const o = await overview(e);
    expect(o.lists.find(l => l.programKey === 'longevity-program')!.counts).toMatchObject({ confirmed: 0, unsubscribed: 1 });
    expect(o.entitlement.confirmedContacts).toBe(0);
  });
  it('the RFC 8058 one-click POST through the API does the same', async () => {
    const e = fictionalEngine(); await ready(e); await onList(e);
    const { unsubscribeToken } = await import('./workforce');
    const token = unsubscribeToken(e.deps, PRACTICE, 'longevity-program', addressHash(e.deps.keys, 'avery@fictional.example'), null);
    const reply = await e.http({ routeKey: 'POST /campaigns/public/unsubscribe', body: JSON.stringify({ token }) });
    expect(reply.statusCode).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ data: { outcome: 'unsubscribed' } });
    expect((await overview(e)).lists.find(l => l.programKey === 'longevity-program')!.counts.confirmed).toBe(0);
  });
  it('signing up again after unsubscribing needs a new confirmation', async () => {
    const e = fictionalEngine(); await ready(e); await onList(e);
    const { unsubscribeToken } = await import('./workforce');
    await e.publicSide.unsubscribe(unsubscribeToken(e.deps, PRACTICE, 'longevity-program', addressHash(e.deps.keys, 'avery@fictional.example'), null));
    e.advance(86_400_000);
    await signUp(e, 'avery@fictional.example');
    expect(e.ses.outbox.at(-1)!.subject).toBe('Please confirm: updates about the Longevity Program');
    expect((await overview(e)).lists.find(l => l.programKey === 'longevity-program')!.counts).toMatchObject({ confirmed: 0, unsubscribed: 0 });
  });
});
