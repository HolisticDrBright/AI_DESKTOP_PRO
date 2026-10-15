import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAMPAIGN_SEND_SETTINGS, CAMPAIGN_TEXT_VERSION, LEAD_CONSENT_VERSION, LEAD_PROGRAMS, campaignCounts } from '@/contracts/leadCampaigns';
import { campaignSendReadiness } from './send-settings';
import { createLeadSignupService, type ConfirmationMailer, type ServiceRequest } from './service';
import { createDittofeedDirectory, createFictionalDirectory } from './dittofeed';
import { createBounceHandler, createDittofeedSesRelay, type SnsHttpNotification } from './bounces';
import { sesEventsHandlerFrom } from './ses-events-lambda';
import { leadUserId, openSignup, sealSignup, CONFIRM_TTL_MS } from './signup-token';
import { campaignEmailProblems, programPageEmailUrl } from './campaign-content';
import { createSesConfirmationMailer, leadSignupEnvironment } from './server';

/** The campaign service's sign-up, confirmation, unsubscribe and bounce paths. Fictional addresses only. */
const linkKey = Buffer.alloc(32, 1), idKey = Buffer.alloc(32, 2);
const config = { publicOrigin: 'https://updates.fictional.example', linkKey, idKey, statsToken: 's'.repeat(40) };
const sendEnv = { CAMPAIGN_SENDING_SUBDOMAIN: 'mail.fictional.example', CAMPAIGN_FROM_NAME: 'Fictional Clinic', CAMPAIGN_MAILING_ADDRESS: '1 Fictional Way, Testville, CA 90000',
  CAMPAIGN_TRACKING: 'off', CAMPAIGN_APPROVED_TEXT_VERSION: CAMPAIGN_TEXT_VERSION };
const mailingAddress = sendEnv.CAMPAIGN_MAILING_ADDRESS;
const T0 = Date.parse('2026-10-13T12:00:00Z');
function world(now = () => T0, env: Record<string, string | undefined> = sendEnv) {
  const fictional = createFictionalDirectory();
  const outbox: { to: string; subject: string; text: string }[] = [];
  const mailer: ConfirmationMailer & { fail: boolean } = { fail: false, async send(m) { if (this.fail) return false; outbox.push(m); return true; } };
  const handle = createLeadSignupService({ config, sending: campaignSendReadiness(env), directory: fictional.directory, mailer, now });
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
    expect(w.outbox[0]!.text).toContain(mailingAddress);
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
    const raw = Buffer.from(token, 'base64url');
    const altered = Buffer.from(raw.map((byte, i) => (i === 20 ? byte ^ 1 : byte))).toString('base64url');
    const truncated = raw.subarray(0, raw.length - 1).toString('base64url');
    for (const t of [forged, altered, truncated, 'x', '']) expect(openSignup(linkKey, t, T0).ok, t).toBe(false);
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
    expect(await handle(sns({ eventType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ava@fictional.example' }] } }))).toEqual({ removed: 0, ignored: 1, relayed: 0 });
    expect(w.fictional.members.get(leadUserId(idKey, 'ava@fictional.example'))!.programs.size).toBe(1);
    expect(await handle(sns({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'AVA@fictional.example' }] } }))).toEqual({ removed: 1, ignored: 0, relayed: 0 });
    expect(w.fictional.members.get(leadUserId(idKey, 'ava@fictional.example'))!.programs.size).toBe(0);
    expect(await handle(sns({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ben@fictional.example' }] } }))).toEqual({ removed: 1, ignored: 0, relayed: 0 });
  });
  it('refuses another topic; a directory failure throws so the event is retried, not lost', async () => {
    const f = createFictionalDirectory();
    const handle = createBounceHandler({ topicArn: topic, idKey, directory: f.directory });
    await expect(handle(sns({ eventType: 'Complaint' }, 'arn:aws:sns:us-east-2:111122223333:other'))).rejects.toThrow('bounce_event_refused');
    f.setDown(true);
    await expect(handle(sns({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ava@fictional.example' }] } }))).rejects.toThrow('campaign_directory_unavailable');
  });
  it('relays every notification from the configured topic to Dittofeed on the private network, after the removal, as SNS would have posted it', async () => {
    const f = createFictionalDirectory();
    const relayed: SnsHttpNotification[] = [];
    const record = (message: unknown, extra: Record<string, unknown> = {}) => ({ EventSource: 'aws:sns', Sns: { Type: 'Notification', MessageId: 'fictional-message', TopicArn: topic,
      Subject: null, Message: JSON.stringify(message), Timestamp: '2026-10-14T12:00:00.000Z', SignatureVersion: '2', Signature: 'fictional-signature',
      SigningCertUrl: 'https://sns.us-east-2.amazonaws.com/fictional.pem', UnsubscribeUrl: 'https://sns.us-east-2.amazonaws.com/?Action=Unsubscribe', ...extra } });
    const handle = createBounceHandler({ topicArn: topic, idKey, directory: f.directory, relay: async n => { relayed.push(n); } });
    expect(await handle({ Records: [record({ eventType: 'Delivery' }), record({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ava@fictional.example' }] } })] }))
      .toEqual({ removed: 1, ignored: 1, relayed: 2 });
    expect(relayed[0]).toEqual({ Type: 'Notification', MessageId: 'fictional-message', TopicArn: topic, Message: JSON.stringify({ eventType: 'Delivery' }),
      Timestamp: '2026-10-14T12:00:00.000Z', SignatureVersion: '2', Signature: 'fictional-signature', SigningCertURL: 'https://sns.us-east-2.amazonaws.com/fictional.pem',
      UnsubscribeURL: 'https://sns.us-east-2.amazonaws.com/?Action=Unsubscribe' });
    // A relay failure throws after the removal, so the retry repeats an idempotent removal and nothing is lost.
    const failing = createBounceHandler({ topicArn: topic, idKey, directory: f.directory, relay: async () => { throw new Error('ses_event_relay_failed'); } });
    await expect(failing({ Records: [record({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ben@fictional.example' }] } })] })).rejects.toThrow('ses_event_relay_failed');
    // A record without its signature fields cannot be relayed as genuine.
    await expect(handle({ Records: [record({ eventType: 'Delivery' }, { Signature: '' })] })).rejects.toThrow('bounce_event_refused');
  });
  it('the relay posts only to the internal Dittofeed address, never following a redirect, and a refusal is a failure', async () => {
    const calls: Array<{ url: string; init: { redirect: string; headers: Record<string, string> } }> = [];
    const relay = createDittofeedSesRelay('http://dittofeed.campaigns.internal:3000', (async (url: string, init: never) => { calls.push({ url, init }); return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 401 }; }) as never);
    const notification = { Type: 'Notification', MessageId: 'm', TopicArn: topic, Message: '{}', Timestamp: 't', SignatureVersion: '2', Signature: 's', SigningCertURL: 'c', UnsubscribeURL: 'u' };
    await relay(notification);
    await expect(relay(notification)).rejects.toThrow('ses_event_relay_failed');
    expect(calls[0]!.url).toBe('http://dittofeed.campaigns.internal:3000/api/public/webhooks/amazon-ses');
    expect(calls[0]!.init.redirect).toBe('error');
    for (const base of ['https://public.fictional.example/', 'http://dittofeed.campaigns.internal:3000/x', '']) expect(() => createDittofeedSesRelay(base), base).toThrow('relay_configuration_invalid');
  });
  it('the events function reads its two secrets itself, and refuses to start with anything missing', async () => {
    const env = { LEAD_SES_EVENTS_TOPIC_ARN: topic, DITTOFEED_INTERNAL_URL: 'http://dittofeed.campaigns.internal:3000', DITTOFEED_WORKSPACE_ID: '20000000-0000-4000-8000-000000000001',
      DITTOFEED_GROUP_LONGEVITY_PROGRAM: '10000000-0000-4000-8000-000000000001', DITTOFEED_GROUP_WEIGHT_LOSS_PROGRAM: '10000000-0000-4000-8000-000000000002', DITTOFEED_GROUP_DIABETES_PROGRAM: '10000000-0000-4000-8000-000000000003',
      LEAD_SIGNUP_ID_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-id-key', DITTOFEED_API_KEYS_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional-api-keys' };
    const read = async (arn: string) => arn.endsWith('id-key') ? idKey.toString('base64') : JSON.stringify({ writeKey: 'w'.repeat(20), adminKey: 'a'.repeat(20) });
    await expect(sesEventsHandlerFrom(env, read)).resolves.toBeTypeOf('function');
    for (const key of Object.keys(env)) await expect(sesEventsHandlerFrom({ ...env, [key]: '' }, read), key).rejects.toThrow();
    await expect(sesEventsHandlerFrom(env, async arn => arn.endsWith('id-key') ? 'c2hvcnQ=' : '{}')).rejects.toThrow('ses_events_configuration_invalid');
  });
  it('the Dittofeed writes use the write key only: identify, then subscribe; unsubscribe covers every list', async () => {
    const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const fetcher = vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => { calls.push({ url, auth: init.headers.authorization!, body: JSON.parse(init.body ?? '{}') }); return { ok: true, status: 200, json: async () => ({}) }; });
    const groups = { 'longevity-program': '10000000-0000-4000-8000-000000000001', 'weight-loss-program': '10000000-0000-4000-8000-000000000002', 'diabetes-program': '10000000-0000-4000-8000-000000000003' };
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
  it('every campaign email must carry the unsubscribe link, sender and address, link only to its program page with ?via=email, and follow the funnel rules', () => {
    const programPageUrl = programPageEmailUrl('https://clinic.fictional.example', 'longevity-program');
    expect(programPageUrl).toBe('https://clinic.fictional.example/learn/longevity-program?via=email');
    const rules = { senderName: 'Fictional Clinic', mailingAddress, programPageUrl };
    const good = { subject: 'What the Longevity Program involves', body: `Hello {{ user.firstName | default: 'there' }},\nHere is how the program works.\nRead about the program: ${programPageUrl}\n\nFictional Clinic\n${mailingAddress}\n{% unsubscribe_link %}` };
    expect(campaignEmailProblems(good, rules)).toEqual([]);
    expect(campaignEmailProblems({ ...good, body: good.body.replace('{% unsubscribe_link %}', '') }, rules)).toContain('no unsubscribe link');
    expect(campaignEmailProblems({ ...good, body: good.body.replace(mailingAddress, '') }, rules)).toContain('no mailing address');
    expect(campaignEmailProblems({ ...good, body: good.body.replace(programPageUrl, '') }, rules)).toContain('no link to the program page');
    expect(campaignEmailProblems({ ...good, body: good.body + '\nLose 20 lbs with semaglutide.' }, rules).length).toBeGreaterThan(0);
    expect(campaignEmailProblems({ ...good, body: good.body + '\nSee https://tracker.fictional.example/x' }, rules)).toContain('no address of any kind in funnel copy');
    // Not even the consult page directly: the reader goes through the program page, whose button is the email consult link.
    expect(campaignEmailProblems({ ...good, body: good.body + '\nhttps://clinic.fictional.example/consult/longevity-program' }, rules)).toContain('no address of any kind in funnel copy');
    // Another program's page is another address.
    expect(campaignEmailProblems({ ...good, body: good.body + `\n${programPageEmailUrl('https://clinic.fictional.example', 'diabetes-program')}` }, rules)).toContain('no address of any kind in funnel copy');
    expect(campaignEmailProblems({ ...good, body: good.body + '\nYou chose {{ user.consent_diabetes_program }}' }, rules)).toContain('only the first name may be filled in from the reader');
    expect(campaignEmailProblems({ ...good, body: good.body + '\nThis program treats fatigue.' }, rules)).toContain('no claim to treat or heal');
    expect(campaignEmailProblems({ ...good, body: good.body + '\n[[UPDATE]]' }, rules)).toContain('an unfilled placeholder');
    for (const origin of ['http://clinic.fictional.example', 'https://clinic.fictional.example/x', 'https://u:p@clinic.fictional.example']) {
      expect(() => programPageEmailUrl(origin, 'longevity-program'), origin).toThrow('site_origin_invalid');
    }
  });
});

describe('sending settings', () => {
  it('have no defaults: with any unset, malformed or unapproved, the service is not ready and names exactly what is missing', () => {
    expect(campaignSendReadiness({})).toEqual({ ready: false, missing: [...CAMPAIGN_SEND_SETTINGS] });
    const ready = campaignSendReadiness(sendEnv);
    expect(ready).toEqual({ ready: true, missing: [], values: { subdomain: 'mail.fictional.example', fromName: 'Fictional Clinic', fromAddress: 'updates@mail.fictional.example', mailingAddress, tracking: 'off' } });
    for (const name of CAMPAIGN_SEND_SETTINGS) expect(campaignSendReadiness({ ...sendEnv, [name]: '' }), name).toEqual({ ready: false, missing: [name] });
    for (const [name, value] of [
      ['CAMPAIGN_SENDING_SUBDOMAIN', 'fictional'], ['CAMPAIGN_SENDING_SUBDOMAIN', '127.0.0.1'], ['CAMPAIGN_SENDING_SUBDOMAIN', 'https://mail.fictional.example'],
      ['CAMPAIGN_FROM_NAME', 'Clinic <evil@x>'], ['CAMPAIGN_FROM_NAME', 'Line\nbreak'], ['CAMPAIGN_MAILING_ADDRESS', 'short'],
      ['CAMPAIGN_TRACKING', 'yes'], ['CAMPAIGN_TRACKING', 'ON'], ['CAMPAIGN_APPROVED_TEXT_VERSION', 'lead-signup-text/0'], ['CAMPAIGN_APPROVED_TEXT_VERSION', 'approved'],
    ] as const) expect(campaignSendReadiness({ ...sendEnv, [name]: value }).missing, `${name}=${value}`).toEqual([name]);
    expect(campaignSendReadiness({ ...sendEnv, CAMPAIGN_TRACKING: 'on' })).toMatchObject({ ready: true, values: { tracking: 'on' } });
  });
  it('while not ready: no form is shown, a submitted form sends nothing, and the counts name the missing settings without any value', async () => {
    const w = world(() => T0, { ...sendEnv, CAMPAIGN_MAILING_ADDRESS: undefined, CAMPAIGN_APPROVED_TEXT_VERSION: undefined });
    const page = await w.handle(w.req('GET', '/signup/longevity-program'));
    expect(page.status).toBe(503);
    expect(page.body).toContain('are not open yet');
    expect(page.body).not.toMatch(/<form|<input/);
    const posted = await w.handle(w.req('POST', '/signup', { form: signup }));
    expect(posted.status).toBe(503);
    expect(w.outbox).toEqual([]);
    expect(w.fictional.members.size).toBe(0);
    const counts = JSON.parse((await w.handle(w.req('GET', '/internal/counts', { auth: `Bearer ${config.statsToken}` }))).body);
    expect(counts.sending).toEqual({ ready: false, missing: ['CAMPAIGN_MAILING_ADDRESS', 'CAMPAIGN_APPROVED_TEXT_VERSION'] });
    expect(campaignCounts.safeParse(counts).success).toBe(true);
    expect(JSON.stringify(counts)).not.toMatch(/mail\.fictional\.example|Fictional Clinic|Fictional Way/);
  });
  it('when ready, the counts say so, and the confirmation is sent from the marketing subdomain under the decided name', async () => {
    const w = world();
    const counts = JSON.parse((await w.handle(w.req('GET', '/internal/counts', { auth: `Bearer ${config.statsToken}` }))).body);
    expect(counts.sending).toEqual({ ready: true, missing: [] });
    const sent: unknown[] = [];
    const mailer = createSesConfirmationMailer({ region: 'us-east-2', configurationSet: 'alp-marketing' }, (campaignSendReadiness(sendEnv) as { values: Parameters<typeof createSesConfirmationMailer>[1] }).values,
      { send: async (command: { input: unknown }) => { sent.push(command.input); return { MessageId: 'fictional-message' }; } } as never);
    expect(await mailer.send({ to: 'ava@fictional.example', subject: 'S', text: 'T' })).toBe(true);
    expect(sent[0]).toMatchObject({ FromEmailAddress: '"Fictional Clinic" <updates@mail.fictional.example>', ConfigurationSetName: 'alp-marketing', Destination: { ToAddresses: ['ava@fictional.example'] } });
  });
});

describe('configuration and separation', () => {
  const env = {
    LEAD_SIGNUP_PUBLIC_ORIGIN: 'https://updates.fictional.example', LEAD_SIGNUP_LINK_KEY: Buffer.alloc(32, 1).toString('base64'), LEAD_SIGNUP_ID_KEY: Buffer.alloc(32, 2).toString('base64'),
    DITTOFEED_INTERNAL_URL: 'http://dittofeed:3000', DITTOFEED_WORKSPACE_ID: '20000000-0000-4000-8000-000000000001', DITTOFEED_WRITE_KEY: 'w'.repeat(20), DITTOFEED_ADMIN_KEY: 'a'.repeat(20),
    DITTOFEED_GROUP_LONGEVITY_PROGRAM: '10000000-0000-4000-8000-000000000001', DITTOFEED_GROUP_WEIGHT_LOSS_PROGRAM: '10000000-0000-4000-8000-000000000002', DITTOFEED_GROUP_DIABETES_PROGRAM: '10000000-0000-4000-8000-000000000003',
    LEAD_SIGNUP_STATS_TOKEN: 's'.repeat(40), LEAD_SES_REGION: 'us-east-2', LEAD_SES_CONFIGURATION_SET: 'alp-marketing',
  };
  it('refuses to start without every wiring value, with one key for both purposes, or on the clinical SES configuration set', () => {
    expect(leadSignupEnvironment(env)).not.toBeNull();
    for (const key of Object.keys(env)) expect(leadSignupEnvironment({ ...env, [key]: '' }), key).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SIGNUP_ID_KEY: env.LEAD_SIGNUP_LINK_KEY })).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SES_CONFIGURATION_SET: 'alp-transactional' })).toBeNull();
    expect(leadSignupEnvironment({ ...env, LEAD_SIGNUP_PUBLIC_ORIGIN: 'http://updates.fictional.example' })).toBeNull();
  });
  it('starts without the sending settings, so it can say what is missing, and is then not ready to send', () => {
    expect(leadSignupEnvironment(env)!.sending).toEqual({ ready: false, missing: [...CAMPAIGN_SEND_SETTINGS] });
    expect(leadSignupEnvironment({ ...env, ...sendEnv })!.sending.ready).toBe(true);
  });
  it('the campaign service imports nothing clinical, and nothing in the Desktop imports the campaign service', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(e => statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]);
    const allowed = /^(node:|zod$|@aws-sdk\/client-(sesv2|secrets-manager)$|@\/contracts\/leadCampaigns$|@\/funnels\/schema$|\.\/|vitest$|\.\.\/\.\.\/scripts\/build-lead-campaigns\.mjs$)/;
    for (const file of files('src/lead-signup')) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) expect(spec, `${file} imports ${spec}`).toMatch(allowed);
    }
    for (const file of files('src').filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith(join('src', 'lead-signup')))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"](?:@\/lead-signup|(?:\.\.\/)+lead-signup)/);
    }
  });
});
