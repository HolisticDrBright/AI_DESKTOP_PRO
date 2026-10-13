import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_CONSENT_VERSION, LEAD_PROGRAMS } from '@/contracts/leadCampaigns';
import { createLeadSignupService, type ConfirmationMailer, type ServiceRequest } from './service';
import { createDittofeedDirectory, createFictionalDirectory } from './dittofeed';
import { createBounceHandler } from './bounces';
import { leadUserId, openSignup, sealSignup, CONFIRM_TTL_MS } from './signup-token';
import { campaignEmailProblems } from './campaign-content';
import { leadSignupEnvironment } from './server';

/** The campaign service's sign-up, confirmation, unsubscribe and bounce paths. Fictional addresses only. */
const linkKey = Buffer.alloc(32, 1), idKey = Buffer.alloc(32, 2);
const config = { publicOrigin: 'https://updates.fictional.example', linkKey, idKey, statsToken: 's'.repeat(40), senderName: 'Fictional Clinic', mailingAddress: '1 Fictional Way, Testville, CA 90000' };
const T0 = Date.parse('2026-10-13T12:00:00Z');
function world(now = () => T0) {
  const fictional = createFictionalDirectory();
  const outbox: { to: string; subject: string; text: string }[] = [];
  const mailer: ConfirmationMailer & { fail: boolean } = { fail: false, async send(m) { if (this.fail) return false; outbox.push(m); return true; } };
  const handle = createLeadSignupService({ config, directory: fictional.directory, mailer, now });
  const req = (method: string, path: string, opts: { form?: Record<string, string>; query?: Record<string, string>; auth?: string } = {}): ServiceRequest =>
    ({ method, path, query: new URLSearchParams(opts.query ?? {}), form: opts.form ? new URLSearchParams(opts.form) : null, authorization: opts.auth ?? null });
  const tokenFrom = (text: string) => /\/confirm\?t=([A-Za-z0-9_.-]+)/.exec(text)![1]!;
  return { fictional, outbox, mailer, handle, req, tokenFrom };
}
const signup = { email: 'Ava@Fictional.Example', firstName: 'Ava', program: 'longevity-program', consent: 'yes' };

describe('sign-up', () => {
  it('shows the form for a known program only, with an unticked consent box and no script', async () => {
    const w = world();
    const page = await w.handle(w.req('GET', '/signup/longevity-program'));
    expect(page.status).toBe(200);
    expect(page.body).toContain('type="checkbox" name="consent" value="yes"');
    expect(page.body).not.toMatch(/checked|<script|<img|<iframe|https?:\/\//);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await w.handle(w.req('GET', '/signup/unknown-program'))).status).toBe(404);
  });
  it('without the box ticked, or with a bad address, nothing is sent and nothing is stored', async () => {
    const w = world();
    for (const form of [{ ...signup, consent: '' }, { email: signup.email, firstName: '', program: signup.program }, { ...signup, email: 'not-an-address' }, { ...signup, firstName: '<b>Ava</b>' }]) {
      expect((await w.handle(w.req('POST', '/signup', { form: form as Record<string, string> }))).status).toBe(400);
    }
    expect(w.outbox).toEqual([]); expect(w.fictional.members.size).toBe(0);
  });
  it('a valid sign-up sends exactly one confirmation email and stores nothing; the page is the same for every address', async () => {
    const w = world();
    const first = await w.handle(w.req('POST', '/signup', { form: signup }));
    const second = await w.handle(w.req('POST', '/signup', { form: { ...signup, email: 'someone.else@fictional.example' } }));
    expect(first.body).toBe(second.body);
    expect(w.outbox).toHaveLength(2);
    expect(w.outbox[0]).toMatchObject({ to: 'ava@fictional.example', subject: 'Confirm your email to get updates about the Longevity Program' });
    expect(w.outbox[0]!.text).toContain('https://updates.fictional.example/confirm?t=');
    expect(w.outbox[0]!.text).toContain(config.mailingAddress);
    expect(w.fictional.members.size).toBe(0);
  });
  it('a mail failure says so, and still stores nothing', async () => {
    const w = world(); w.mailer.fail = true;
    const page = await w.handle(w.req('POST', '/signup', { form: signup }));
    expect(page.status).toBe(503); expect(page.body).toContain('Nothing was saved');
  });
});

describe('confirmation', () => {
  it('opening the link changes nothing (a mail scanner cannot confirm); the button subscribes that program only, with the consent version', async () => {
    const w = world();
    await w.handle(w.req('POST', '/signup', { form: signup }));
    const t = w.tokenFrom(w.outbox[0]!.text);
    const opened = await w.handle(w.req('GET', '/confirm', { query: { t } }));
    expect(opened.status).toBe(200); expect(opened.body).toContain('method="post" action="/confirm"');
    expect(w.fictional.members.size).toBe(0);
    const confirmed = await w.handle(w.req('POST', '/confirm', { form: { t } }));
    expect(confirmed.status).toBe(200);
    const member = w.fictional.members.get(leadUserId(idKey, 'ava@fictional.example'))!;
    expect([...member.programs]).toEqual(['longevity-program']);
    expect(member.consent).toEqual({ 'longevity-program': LEAD_CONSENT_VERSION });
    expect((await w.handle(w.req('GET', '/internal/counts', { auth: `Bearer ${config.statsToken}` }))).body).toContain('"confirmed":1');
  });
  it('a forged, altered or expired link confirms nothing', async () => {
    const w = world(() => T0 + CONFIRM_TTL_MS + 1);
    const token = sealSignup(linkKey, { email: 'ava@fictional.example', firstName: null, program: 'diabetes-program', consentVersion: LEAD_CONSENT_VERSION, issuedAt: T0 });
    expect((await w.handle(w.req('POST', '/confirm', { form: { t: token } }))).body).toContain('expired');
    const forged = sealSignup(Buffer.alloc(32, 9), { email: 'ava@fictional.example', firstName: null, program: 'diabetes-program', consentVersion: LEAD_CONSENT_VERSION, issuedAt: T0 });
    const [body, mac] = token.split('.');
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), p: 'longevity-program' })).toString('base64url') + '.' + mac;
    for (const t of [forged, altered, 'x', '']) expect(openSignup(linkKey, t, T0).ok, t).toBe(false);
    expect(w.fictional.members.size).toBe(0);
  });
  it('a directory outage is shown as one, and nothing is claimed', async () => {
    const w = world(); w.fictional.setDown(true);
    await w.handle(w.req('POST', '/signup', { form: signup }));
    const page = await w.handle(w.req('POST', '/confirm', { form: { t: w.tokenFrom(w.outbox[0]!.text) } }));
    expect(page.status).toBe(503); expect(page.body).toContain('Nothing was changed');
  });
  it('counts need the stats token and are numbers only', async () => {
    const w = world();
    expect((await w.handle(w.req('GET', '/internal/counts'))).status).toBe(401);
    expect((await w.handle(w.req('GET', '/internal/counts', { auth: 'Bearer wrong' }))).status).toBe(401);
    const counts = JSON.parse((await w.handle(w.req('GET', '/internal/counts', { auth: `Bearer ${config.statsToken}` }))).body);
    expect(counts.lists.map((l: { program: string }) => l.program)).toEqual([...LEAD_PROGRAMS]);
    expect(JSON.stringify(counts)).not.toMatch(/@/);
  });
});

describe('unsubscribe and bounces', () => {
  const topic = 'arn:aws:sns:us-east-2:111122223333:fictional-marketing-ses-events';
  const sns = (message: unknown, topicArn = topic) => ({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: topicArn, Message: JSON.stringify(message) } }] });
  it('a hard bounce or complaint unsubscribes the person from every list; a soft bounce does not', async () => {
    const w = world();
    await w.handle(w.req('POST', '/signup', { form: signup }));
    await w.handle(w.req('POST', '/confirm', { form: { t: w.tokenFrom(w.outbox[0]!.text) } }));
    const handle = createBounceHandler({ topicArn: topic, idKey, directory: w.fictional.directory });
    expect(await handle(sns({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ava@fictional.example' }] } }))).toEqual({ removed: 0, ignored: 1 });
    expect(w.fictional.members.get(leadUserId(idKey, 'ava@fictional.example'))!.programs.size).toBe(1);
    expect(await handle(sns({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'AVA@fictional.example' }] } }))).toEqual({ removed: 1, ignored: 0 });
    expect(w.fictional.members.get(leadUserId(idKey, 'ava@fictional.example'))!.programs.size).toBe(0);
    expect(await handle(sns({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ben@fictional.example' }] } }))).toEqual({ removed: 1, ignored: 0 });
  });
  it('refuses another topic; a directory failure throws so the event is retried, not lost', async () => {
    const f = createFictionalDirectory();
    const handle = createBounceHandler({ topicArn: topic, idKey, directory: f.directory });
    await expect(handle(sns({ eventType: 'Complaint' }, 'arn:aws:sns:us-east-2:111122223333:other'))).rejects.toThrow('bounce_event_refused');
    f.setDown(true);
    await expect(handle(sns({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ava@fictional.example' }] } }))).rejects.toThrow('campaign_directory_unavailable');
  });
  it('the Dittofeed writes use the write key only: identify, then subscribe; unsubscribe covers every list', async () => {
    const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const fetcher = vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => { calls.push({ url, auth: init.headers.authorization!, body: JSON.parse(init.body ?? '{}') }); return { ok: true, status: 200, json: async () => ({}) }; });
    const groups = { 'longevity-program': '10000000-0000-4000-8000-000000000001', 'weight-loss-peptide-program': '10000000-0000-4000-8000-000000000002', 'diabetes-program': '10000000-0000-4000-8000-000000000003' };
    const d = createDittofeedDirectory({ baseUrl: 'http://dittofeed.internal:3000', workspaceId: '20000000-0000-4000-8000-000000000001', writeKey: 'fictional-write-key', adminKey: 'fictional-admin-key', groups }, fetcher as never);
    await d.confirm({ userId: 'lead_x', email: 'ava@fictional.example', firstName: null, program: 'diabetes-program', consentVersion: LEAD_CONSENT_VERSION, confirmedAt: '2026-10-13T12:00:00.000Z' });
    await d.unsubscribeAll('lead_x');
    expect(calls.map(c => [c.url.replace('http://dittofeed.internal:3000', ''), c.auth])).toEqual([
      ['/api/public/apps/identify', 'Basic fictional-write-key'], ['/api/public/apps/track', 'Basic fictional-write-key'],
      ['/api/public/apps/track', 'Basic fictional-write-key'], ['/api/public/apps/track', 'Basic fictional-write-key'], ['/api/public/apps/track', 'Basic fictional-write-key'],
    ]);
    expect(calls[1]!.body).toMatchObject({ userId: 'lead_x', event: 'DFSubscriptionChange', properties: { subscriptionId: groups['diabetes-program'], action: 'Subscribe' } });
    expect(calls.slice(2).map(c => (c.body.properties as { action: string }).action)).toEqual(['Unsubscribe', 'Unsubscribe', 'Unsubscribe']);
    expect(calls[0]!.body.traits).toEqual({ email: 'ava@fictional.example', consent_diabetes_program: { version: LEAD_CONSENT_VERSION, confirmedAt: '2026-10-13T12:00:00.000Z' } });
  });
  it('every campaign email must carry the unsubscribe link, sender and address, and follow the funnel rules', () => {
    const rules = { senderName: 'Fictional Clinic', mailingAddress: config.mailingAddress, consultUrls: ['https://clinic.fictional.example/consult/longevity-program'] };
    const good = { subject: 'What the Longevity Program involves', body: `Hello {{ user.firstName | default: 'there' }},\nHere is how the program works.\nRequest a consultation: https://clinic.fictional.example/consult/longevity-program\n\nFictional Clinic\n${config.mailingAddress}\n{% unsubscribe_link %}` };
    expect(campaignEmailProblems(good, rules)).toEqual([]);
    expect(campaignEmailProblems({ ...good, body: good.body.replace('{% unsubscribe_link %}', '') }, rules)).toContain('no unsubscribe link');
    expect(campaignEmailProblems({ ...good, body: good.body.replace(config.mailingAddress, '') }, rules)).toContain('no mailing address');
    expect(campaignEmailProblems({ ...good, body: good.body + '\nLose 20 lbs with semaglutide.' }, rules).length).toBeGreaterThan(0);
    expect(campaignEmailProblems({ ...good, body: good.body + '\nSee https://tracker.fictional.example/x' }, rules)).toContain('no address of any kind in funnel copy');
    expect(campaignEmailProblems({ ...good, body: good.body + '\nYou chose {{ user.consent_diabetes_program }}' }, rules)).toContain('only the first name may be filled in from the reader');
  });
});

describe('configuration and separation', () => {
  const env = {
    LEAD_SIGNUP_PUBLIC_ORIGIN: 'https://updates.fictional.example', LEAD_SIGNUP_LINK_KEY: Buffer.alloc(32, 1).toString('base64'), LEAD_SIGNUP_ID_KEY: Buffer.alloc(32, 2).toString('base64'),
    DITTOFEED_INTERNAL_URL: 'http://dittofeed:3000', DITTOFEED_WORKSPACE_ID: '20000000-0000-4000-8000-000000000001', DITTOFEED_WRITE_KEY: 'w'.repeat(20), DITTOFEED_ADMIN_KEY: 'a'.repeat(20),
    DITTOFEED_GROUP_LONGEVITY_PROGRAM: '10000000-0000-4000-8000-000000000001', DITTOFEED_GROUP_WEIGHT_LOSS_PEPTIDE_PROGRAM: '10000000-0000-4000-8000-000000000002', DITTOFEED_GROUP_DIABETES_PROGRAM: '10000000-0000-4000-8000-000000000003',
    LEAD_SIGNUP_STATS_TOKEN: 's'.repeat(40), LEAD_SES_REGION: 'us-east-2', LEAD_SES_SENDER: 'updates@mail.fictional.example', LEAD_SES_CONFIGURATION_SET: 'alp-marketing',
    LEAD_SENDER_NAME: 'Fictional Clinic', LEAD_MAILING_ADDRESS: '1 Fictional Way, Testville, CA 90000',
  };
  it('refuses to start without every value, with one key for both purposes, or on the clinical SES configuration set', () => {
    expect(leadSignupEnvironment(env)).not.toBeNull();
    for (const key of Object.keys(env)) expect(leadSignupEnvironment({ ...env, [key]: '' }), key).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SIGNUP_ID_KEY: env.LEAD_SIGNUP_LINK_KEY })).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SES_CONFIGURATION_SET: 'alp-transactional' })).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SIGNUP_PUBLIC_ORIGIN: 'http://updates.fictional.example' })).toBeNull();
  });
  it('the campaign service imports nothing clinical, and nothing in the Desktop imports the campaign service', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(e => statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]);
    const allowed = /^(node:|zod$|@aws-sdk\/client-sesv2$|@\/contracts\/leadCampaigns$|@\/funnels\/schema$|\.\/|vitest$)/;
    for (const file of files('src/lead-signup')) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) expect(spec, `${file} imports ${spec}`).toMatch(allowed);
    }
    for (const file of files('src').filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith(join('src', 'lead-signup')))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"](?:@\/lead-signup|(?:\.\.\/)+lead-signup)/);
    }
  });
});
