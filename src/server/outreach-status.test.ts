import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatus } from '@/campaigns/contract';
import { allFunnels } from '@/funnels';
import { OUTREACH_STEPS, outreachRows, readEngineStatus, readSignupPages, type EngineRead, type OutreachRow, type SignupRead } from './outreach-status';

/**
 * The Outreach status rows. Every setting off reads off or can't tell, never on; a setting held by another service
 * reads can't tell, never off; a campaign engine that does not answer leaves its rows at can't tell; and no configured
 * value, address or list reaches a row. The go-live document lists the same settings in the same order. Fictional
 * values only.
 */
const API = 'https://abcdefghij.execute-api.us-east-2.amazonaws.com';
const OFF = { switched_off: { kind: 'switched_off' } as EngineRead, not_set: { kind: 'not_set' } as SignupRead };
const DISABLED = { kind: 'disabled', reason: 'commerce_disabled' } as const;
const rows = (over: { env?: Record<string, string>; engine?: EngineRead; signup?: SignupRead } = {}) =>
  outreachRows({ env: over.env ?? {}, funnels: allFunnels(), engine: over.engine ?? OFF.switched_off, signup: over.signup ?? OFF.not_set, offers: DISABLED });
const row = (all: OutreachRow[], id: string) => { const r = all.find(x => x.id === id); if (!r) throw new Error(id); return r; };
const ready = (over: Partial<EngineStatus> = {}): EngineRead => ({ kind: 'read', status: {
  action: 'status', contract: 'campaign-engine/1', marketing: true, tier: 'growth', domain: { verifiedForSending: true, dkim: 'success', mailFrom: 'success' },
  readiness: { canSend: true, missing: [] }, sesProductionAccess: 'granted', activeSequences: ['longevity-program'], scheduledBroadcasts: 0, approvedTemplates: 3, ...over } });
const ELSEWHERE = ['reminder-emails', 'consult-booked-email', 'notification-preferences-service', 'notification-settings-app', 'patient-notices', 'sms-reminders', 'sms-notices'];

describe('with every setting off', () => {
  it('nothing reads on; what lives in another service reads can\'t tell; the rows come in go-live order', () => {
    const all = rows();
    expect(all.filter(r => r.state === 'on')).toEqual([]);
    for (const id of ELSEWHERE) expect(row(all, id).state, id).toBe('unknown');
    for (const r of all.filter(x => !ELSEWHERE.includes(x.id))) expect(r.state, r.id).toBe('off');
    const order = all.map(r => r.step);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect([...new Set(all.map(r => OUTREACH_STEPS[r.step - 1]!.id))]).toEqual(OUTREACH_STEPS.map(s => s.id));
    expect(all.filter(r => r.id.startsWith('program-page:')).map(r => r.id)).toEqual(allFunnels().map(f => `program-page:${f.slug}`));
  });
  it('says why: no public address, drafts with their notes, the engine switched off, purchase withheld', () => {
    const all = rows();
    expect(row(all, 'public-address').reading).toContain('No public address is set');
    for (const f of allFunnels()) expect(row(all, `program-page:${f.slug}`).reading).toBe(`Draft. ${f.draftNote}`);
    expect(row(all, 'program-page:weight-loss-program').blockedUntil).toContain('attorney');
    expect(row(all, 'program-page:longevity-program').blockedUntil).not.toContain('attorney');
    for (const id of ['campaign-engine', 'marketing-entitlement', 'sending-domain', 'campaign-sending']) expect(row(all, id).reading, id).toContain('switched off on this server');
    expect(row(all, 'purchase-offers').reading).toContain('Withheld');
    expect(row(all, 'reminder-emails').reading).toContain('cannot read that service\'s settings');
  });
});

describe('this server\'s own settings', () => {
  it('the public address is on only for the production clinical origin with nothing staging about it', () => {
    const origin = 'https://clinic.fictional.example';
    expect(row(rows({ env: { NEXT_PUBLIC_SITE_ORIGIN: origin, APP_RUNTIME_ENV: 'production-clinical' } }), 'public-address').state).toBe('on');
    expect(row(rows({ env: { NEXT_PUBLIC_SITE_ORIGIN: origin } }), 'public-address').reading).toContain('not the production clinical runtime');
    expect(row(rows({ env: { NEXT_PUBLIC_SITE_ORIGIN: 'https://staging.fictional.example', APP_RUNTIME_ENV: 'production-clinical' } }), 'public-address').reading).toContain('staging or synthetic');
    expect(row(rows({ env: { NEXT_PUBLIC_SITE_ORIGIN: 'http://clinic.fictional.example' } }), 'public-address').reading).toContain('not a valid https origin');
  });
  it('the "received" email is on only when switched on and complete, and otherwise says what is missing', () => {
    const complete = { CONSULT_ENQUIRER_EMAILS_ENABLED: 'true', CONSULT_ENQUIRER_SENDER: 'Fictional Clinic <noreply@fictional.example>', CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional', CONSULT_ENQUIRER_CONTACT_LINE: 'Call 555-0100 during office hours' };
    expect(row(rows({ env: complete }), 'consult-received-email').state).toBe('on');
    expect(row(rows({ env: { ...complete, CONSULT_ENQUIRER_EMAILS_ENABLED: 'TRUE' } }), 'consult-received-email').state).toBe('off');
    const partial = row(rows({ env: { ...complete, CONSULT_ENQUIRER_SENDER: '', CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-marketing' } }), 'consult-received-email');
    expect(partial.state).toBe('off');
    expect(partial.reading).toBe('Switched on, but nothing is sent: no sender is set; the configuration set is not alp-transactional.');
  });
  it('the Desktop\'s notification-choices view follows its own switch; the identity service\'s copy stays can\'t tell', () => {
    const all = rows({ env: { NOTIFICATION_PREFERENCES_ENABLED: 'true' } });
    expect(row(all, 'notification-preferences-desktop').state).toBe('on');
    expect(row(all, 'notification-preferences-service').state).toBe('unknown');
  });
  it('purchase is off under the fixture\'s fictional ledger too', () => {
    const all = outreachRows({ env: {}, funnels: allFunnels(), engine: OFF.switched_off, signup: OFF.not_set, offers: { kind: 'fictional' } as never });
    expect(row(all, 'purchase-offers')).toMatchObject({ state: 'off', reading: expect.stringContaining('fictional') });
  });
});

describe('the campaign engine\'s rows', () => {
  it('an engine that does not answer, or refuses the session, is can\'t tell, never off', () => {
    for (const engine of [{ kind: 'unavailable' }, { kind: 'refused' }, { kind: 'no_session' }] as EngineRead[]) {
      const all = rows({ engine, signup: { kind: 'unavailable' } });
      for (const id of ['campaign-engine', 'marketing-entitlement', 'get-updates-link', 'sending-domain', 'campaign-sending']) expect(row(all, id).state, `${engine.kind} ${id}`).toBe('unknown');
    }
  });
  it('a ready practice reads on, with counts and nothing named', () => {
    const all = rows({ engine: ready(), signup: { kind: 'read', offered: ['longevity-program'], open: ['longevity-program'] } });
    for (const id of ['campaign-engine', 'marketing-entitlement', 'get-updates-link', 'sending-domain', 'campaign-sending']) expect(row(all, id).state, id).toBe('on');
    expect(row(all, 'marketing-entitlement').reading).toBe('Held (growth tier).');
    expect(row(all, 'get-updates-link').reading).toBe('Shown for: Longevity Program. No program page is published yet, so no visitor sees it.');
    expect(row(all, 'campaign-sending').reading).toContain('1 welcome sequence active, 0 broadcasts scheduled, 3 approved emails.');
  });
  it('without the package, with a pending domain, or without production access, each says so', () => {
    const all = rows({ engine: ready({ marketing: false, tier: null, domain: { verifiedForSending: false, dkim: 'pending', mailFrom: 'temporary_failure' },
      readiness: { canSend: false, missing: ['The practice does not hold the marketing package.'] }, sesProductionAccess: 'not_granted' }) });
    expect(row(all, 'marketing-entitlement')).toMatchObject({ state: 'off', reading: 'Not held by this practice.' });
    expect(row(all, 'sending-domain')).toMatchObject({ state: 'off', reading: 'Waiting for the practice\'s DNS records (DKIM: pending; MAIL FROM: temporary failure).' });
    expect(row(all, 'campaign-sending').state).toBe('off');
    expect(row(all, 'campaign-sending').reading).toContain('SES production access has not been granted');
    expect(row(rows({ engine: ready({ domain: null }) }), 'sending-domain').reading).toBe('No sending domain is set for this practice.');
    expect(row(rows({ engine: ready({ sesProductionAccess: 'unknown' }) }), 'campaign-sending').state).toBe('unknown');
  });
});

describe('nothing configured reaches the screen', () => {
  it('no secret, address, sender, origin or slug appears in any row', () => {
    const env = { NEXT_PUBLIC_SITE_ORIGIN: 'https://secret-origin.fictional.example', APP_RUNTIME_ENV: 'production-clinical', CONSULT_ENQUIRER_EMAILS_ENABLED: 'true',
      CONSULT_ENQUIRER_SENDER: 'Hidden Sender <hidden-sender@fictional.example>', CONSULT_ENQUIRER_CONFIGURATION_SET: 'alp-transactional', CONSULT_ENQUIRER_CONTACT_LINE: 'Hidden line 555-0199',
      CAMPAIGN_ENGINE_ENABLED: 'true', CAMPAIGN_API_ORIGIN: API, FUNNEL_PRACTICE_SLUG: 'hidden-practice-slug', CAMPAIGN_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:111122223333:secret:hidden' };
    const text = JSON.stringify(rows({ env, engine: ready(), signup: { kind: 'read', offered: ['longevity-program'], open: ['longevity-program'] } }));
    for (const value of ['secret-origin', 'Hidden Sender', 'hidden-sender', 'Hidden line', 'abcdefghij', 'hidden-practice-slug', '111122223333', '@']) expect(text, value).not.toContain(value);
  });
});

describe('the reads', () => {
  const upstream = vi.fn();
  const env = { CAMPAIGN_ENGINE_ENABLED: 'true', CAMPAIGN_API_ORIGIN: API, FUNNEL_PRACTICE_SLUG: 'fictional-clinic' };
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(status < 300 ? { data } : data), { status, headers: { 'content-type': 'application/json' } });
  beforeEach(() => { upstream.mockReset(); vi.stubGlobal('fetch', upstream); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('switched off or misconfigured, nothing is asked', async () => {
    expect(await readEngineStatus('fictional-token', {})).toEqual({ kind: 'switched_off' });
    expect(await readEngineStatus('fictional-token', { ...env, CAMPAIGN_API_ORIGIN: 'https://evil.example' })).toEqual({ kind: 'misconfigured' });
    expect(await readEngineStatus(null, env)).toEqual({ kind: 'no_session' });
    expect(await readSignupPages({ ...env, FUNNEL_PRACTICE_SLUG: '' })).toEqual({ kind: 'not_set' });
    expect(upstream).not.toHaveBeenCalled();
  });
  it('asks the engine for its flags-only status with the workforce token, and tells a failure from a refusal', async () => {
    const answer = (ready() as Extract<EngineRead, { kind: 'read' }>).status;
    upstream.mockResolvedValueOnce(reply(200, answer));
    expect(await readEngineStatus('fictional-token', env)).toEqual({ kind: 'read', status: answer });
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/campaigns/workforce`);
    expect(JSON.parse(String(init.body))).toEqual({ action: 'status' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fictional-token');
    upstream.mockResolvedValueOnce(reply(403, { error: 'forbidden' }));
    expect(await readEngineStatus('fictional-token', env)).toEqual({ kind: 'refused' });
    upstream.mockResolvedValueOnce(reply(503, { error: 'unavailable' }));
    expect(await readEngineStatus('fictional-token', env)).toEqual({ kind: 'unavailable' });
    upstream.mockResolvedValueOnce(reply(200, { ...answer, contacts: ['avery@fictional.example'] }));
    expect(await readEngineStatus('fictional-token', env)).toEqual({ kind: 'unavailable' });
    upstream.mockRejectedValueOnce(new Error('network'));
    expect(await readEngineStatus('fictional-token', env)).toEqual({ kind: 'unavailable' });
  });
  it('asks whether each offered program\'s sign-up page is open; any failure is unknown, not closed', async () => {
    upstream.mockImplementation(async (url: string) => reply(200, { open: url.endsWith('/longevity-program') }));
    const read = await readSignupPages(env);
    expect(read).toMatchObject({ kind: 'read', open: ['longevity-program'] });
    expect(upstream.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([`${API}/campaigns/public/signup-open/fictional-clinic/longevity-program`]));
    upstream.mockReset();
    upstream.mockRejectedValue(new Error('network'));
    expect(await readSignupPages(env)).toEqual({ kind: 'unavailable' });
  });
});

describe('docs/outreach-go-live.md', () => {
  it('lists the screen\'s settings, in the same order', () => {
    const doc = readFileSync('docs/outreach-go-live.md', 'utf8');
    const table = [...doc.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/gm)].map(m => ({ step: Number(m[1]), setting: m[2], where: m[3], turnsOn: m[4], blockedUntil: m[5], who: m[6] }));
    expect(table).toEqual(OUTREACH_STEPS.map((s, i) => ({ step: i + 1, setting: s.setting, where: s.where, turnsOn: s.turnsOn, blockedUntil: s.blockedUntil, who: s.who })));
  });
});
