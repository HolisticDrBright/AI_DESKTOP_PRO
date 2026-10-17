import { describe, expect, it } from 'vitest';
import { createAwsCampaignSes, dnsRecordsFor, MARKETING_IDENTITY_TAG } from './ses';
import { FORM_MIN_MS } from './public';
import { fictionalEngine, TOPIC, tokenFrom } from './testing';
import { addressHash } from './tokens';

/**
 * Bounces, complaints and the other SES events; the campaign API's routes; and the AWS SES port at its SDK boundary.
 * Fictional practices and addresses only.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const event = (message: unknown, topic = TOPIC) => ({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: topic, Message: JSON.stringify(message) } }] });
const ADMIN_SUBJECT = 'fictional-workforce-admin-0001';
const jwt = (claims: Record<string, unknown> = {}) => ({ authorizer: { jwt: { claims: { sub: ADMIN_SUBJECT, 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, email: ADMIN.email, exp: Date.now() / 1000 + 60, ...claims } } } });

async function onLists(programs: ('longevity-program' | 'diabetes-program')[]) {
  const e = fictionalEngine();
  await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  for (const program of programs) {
    const page = await e.publicSide.joinPage('fictional-clinic', program);
    e.advance(FORM_MIN_MS + 10);
    await e.publicSide.join({ practice: 'fictional-clinic', program, email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
    await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'));
  }
  return { e, hash: addressHash(e.deps.keys, 'avery@fictional.example') };
}
const counts = async (e: ReturnType<typeof fictionalEngine>) => {
  const o = await e.staff.handle(ADMIN, { action: 'overview' });
  if (o.action !== 'overview') throw new Error();
  return o;
};

describe('bounces and complaints', () => {
  it('a permanent bounce removes the address from every list of the practice at once, and a later sign-up sends nothing', async () => {
    const { e, hash } = await onLists(['longevity-program', 'diabetes-program']);
    const template = '0e000000-0000-4000-8000-00000000abcd';
    await e.events(event({ eventType: 'Bounce', bounce: { bounceType: 'Permanent' }, mail: { tags: { practice: [PRACTICE], contact: [hash], template: [template] } } }));
    const o = await counts(e);
    for (const list of o.lists.filter(l => l.programKey !== 'weight-loss-program')) expect(list.counts).toMatchObject({ confirmed: 0, bounced: 1 });
    expect(o.entitlement.confirmedContacts).toBe(0);
    expect(o.results.find(r => r.templateId === template)).toMatchObject({ bounced: 1 });
    const before = e.ses.outbox.length;
    const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
    e.advance(FORM_MIN_MS + 10);
    await e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
    expect(e.ses.outbox.length).toBe(before);
  });
  it('a complaint does the same, and a transient bounce removes nobody', async () => {
    const { e, hash } = await onLists(['longevity-program']);
    await e.events(event({ eventType: 'Bounce', bounce: { bounceType: 'Transient' }, mail: { tags: { practice: [PRACTICE], contact: [hash] } } }));
    expect((await counts(e)).lists[0]!.counts.confirmed).toBe(1);
    await e.events(event({ notificationType: 'Complaint', mail: { tags: { practice: [PRACTICE], contact: [hash] } } }));
    expect((await counts(e)).lists[0]!.counts).toMatchObject({ confirmed: 0, complained: 1 });
  });
  it('accepts only the configured topic and refuses a malformed message, so the invocation is retried', async () => {
    const { e, hash } = await onLists(['longevity-program']);
    await expect(e.events(event({ eventType: 'Complaint', mail: { tags: { practice: [PRACTICE], contact: [hash] } } }, 'arn:aws:sns:us-east-2:999988887777:someone-else'))).rejects.toThrow('campaign_event_refused');
    await expect(e.events({ Records: [{ EventSource: 'aws:sns', Sns: { TopicArn: TOPIC, Message: 'not json' } }] })).rejects.toThrow('campaign_event_refused');
    expect((await counts(e)).lists[0]!.counts.confirmed).toBe(1);
  });
  it('counts deliveries; opens and clicks only when the practice counts them, and never per person', async () => {
    const { e } = await onLists(['longevity-program']);
    const template = '0e000000-0000-4000-8000-00000000abcd';
    const tags = { practice: [PRACTICE], template: [template] };
    await e.events(event({ eventType: 'Delivery', mail: { tags } }));
    await e.events(event({ eventType: 'Open', mail: { tags } }));
    expect((await counts(e)).results.find(r => r.templateId === template)).toEqual({ templateId: template, sent: 0, delivered: 1, bounced: 0, complained: 0, unsubscribed: 0, opened: null, clicked: null });
    const o = await counts(e);
    await e.staff.handle(ADMIN, { action: 'update_settings', expectedVersion: o.settings.version, joinSlug: o.settings.joinSlug, senderName: o.settings.senderName, mailingAddress: o.settings.mailingAddress, timeZone: o.settings.timeZone, trackOpensAndClicks: true });
    await e.events(event({ eventType: 'Open', mail: { tags } }));
    await e.events(event({ eventType: 'Click', mail: { tags } }));
    expect((await counts(e)).results.find(r => r.templateId === template)).toMatchObject({ opened: 1, clicked: 1 });
  });
});

describe('the campaign API', () => {
  it('serves the public routes with fixed shapes, and refuses a query string', async () => {
    const { e } = await onLists([]);
    const page = await e.http({ routeKey: 'GET /campaigns/public/join/{practice}/{program}', pathParameters: { practice: 'fictional-clinic', program: 'longevity-program' } });
    expect(page.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(page.body).data).sort()).toEqual(['consentLine', 'consentVersion', 'formToken', 'practiceName', 'programKey', 'programLabel']);
    expect((await e.http({ routeKey: 'GET /campaigns/public/join/{practice}/{program}', pathParameters: { practice: 'no-such-clinic', program: 'longevity-program' } })).statusCode).toBe(404);
    expect(JSON.parse((await e.http({ routeKey: 'GET /campaigns/public/signup-open/{practice}/{program}', pathParameters: { practice: 'fictional-clinic', program: 'longevity-program' } })).body)).toEqual({ data: { open: true } });
    expect((await e.http({ routeKey: 'POST /campaigns/public/join', body: '{}', queryStringParameters: { email: 'x' } })).statusCode).toBe(400);
    expect((await e.http({ routeKey: 'POST /campaigns/public/confirm', body: JSON.stringify({ token: 'x'.repeat(50), extra: 1 }) })).statusCode).toBe(400);
    expect((await e.http({ routeKey: 'GET /campaigns/secret' })).statusCode).toBe(404);
  });
  it('the staff route needs the authorizer\'s claims and a live token; the practice is the token\'s', async () => {
    const { e } = await onLists([]);
    expect((await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}' })).statusCode).toBe(403);
    expect((await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: jwt({ exp: Date.now() / 1000 - 1 }) })).statusCode).toBe(403);
    expect((await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: jwt({ 'custom:organization_id': 'x' }) })).statusCode).toBe(403);
    const ok = await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: jwt() });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).data).toMatchObject({ action: 'overview', role: 'marketing_admin' });
  });
  it('switched off, every route answers 503', async () => {
    const e = fictionalEngine({ config: { enabled: false } });
    for (const routeKey of ['GET /campaigns/public/join/{practice}/{program}', 'POST /campaigns/public/join', 'POST /campaigns/public/confirm']) {
      const reply = await e.http({ routeKey, pathParameters: { practice: 'fictional-clinic', program: 'longevity-program' }, body: JSON.stringify({ token: 'x'.repeat(60) }) });
      expect(reply.statusCode, routeKey).toBe(503);
    }
    expect((await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: jwt() })).statusCode).toBe(503);
  });
});

describe('the AWS SES port, at its SDK boundary', () => {
  function client(replies: Record<string, unknown> = {}) {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    return { calls, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      const reply = replies[command.constructor.name];
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    } };
  }
  it('sends with the practice tenant, the marketing set, the one-click headers and the tags, and refuses any other set', async () => {
    const c = client({ SendEmailCommand: { MessageId: 'fictional-1' } });
    const ses = createAwsCampaignSes({ client: c as never, region: 'us-east-2', accountId: '111122223333' });
    const message = { from: 'Fictional Clinic <updates@mail.fictional-clinic.example>', to: 'avery@fictional.example', subject: 's', html: '<p>h</p>', text: 't',
      headers: [{ name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }], configurationSet: 'alp-marketing', tenant: 'alp-practice-x', tags: [{ name: 'practice', value: PRACTICE }] };
    expect(await ses.send(message)).toEqual({ outcome: 'accepted', messageId: 'fictional-1' });
    expect(c.calls[0]).toMatchObject({ name: 'SendEmailCommand', input: { ConfigurationSetName: 'alp-marketing', TenantName: 'alp-practice-x', EmailTags: [{ Name: 'practice', Value: PRACTICE }],
      Content: { Simple: { Headers: [{ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] } } } });
    expect(await ses.send({ ...message, configurationSet: 'alp-transactional' })).toEqual({ outcome: 'refused', detail: 'request_invalid' });
    expect(c.calls).toHaveLength(1);
  });
  it('maps an SES error answer to a refusal and no answer to unknown', async () => {
    const answered = Object.assign(new Error('throttled'), { name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } });
    const timeout = Object.assign(new Error('socket hang up'), { name: 'TimeoutError', $metadata: {} });
    const send = (error: Error) => createAwsCampaignSes({ client: client({ SendEmailCommand: error }) as never, region: 'us-east-2', accountId: '111122223333' })
      .send({ from: 'a <updates@b.example>', to: 'c@d.example', subject: 's', html: 'h', text: 't', headers: [], configurationSet: 'alp-marketing', tenant: 't', tags: [] });
    expect(await send(answered)).toEqual({ outcome: 'refused', detail: 'provider_unavailable' });
    expect(await send(timeout)).toEqual({ outcome: 'unknown' });
  });
  it('registers a domain under the practice tenant, tagged as marketing, with a custom MAIL FROM, and lists the DNS records', async () => {
    const c = client({ GetEmailIdentityCommand: { VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: ['tok1', 'tok2', 'tok3'] }, MailFromAttributes: { MailFromDomainStatus: 'PENDING' } } });
    const ses = createAwsCampaignSes({ client: c as never, region: 'us-east-2', accountId: '111122223333' });
    const status = await ses.registerDomain({ domain: 'mail.fictional-clinic.example', tenant: 'alp-practice-x', configurationSets: ['alp-marketing', 'alp-marketing-tracked'] });
    expect(c.calls.map(x => x.name)).toEqual(['CreateTenantCommand', 'CreateEmailIdentityCommand', 'PutEmailIdentityMailFromAttributesCommand',
      'CreateTenantResourceAssociationCommand', 'CreateTenantResourceAssociationCommand', 'CreateTenantResourceAssociationCommand', 'GetEmailIdentityCommand']);
    expect(c.calls[1]!.input).toEqual({ EmailIdentity: 'mail.fictional-clinic.example', Tags: [MARKETING_IDENTITY_TAG] });
    expect(c.calls[2]!.input).toMatchObject({ MailFromDomain: 'bounce.mail.fictional-clinic.example' });
    expect(c.calls.slice(3, 6).map(x => x.input.ResourceArn)).toEqual(['arn:aws:ses:us-east-2:111122223333:identity/mail.fictional-clinic.example',
      'arn:aws:ses:us-east-2:111122223333:configuration-set/alp-marketing', 'arn:aws:ses:us-east-2:111122223333:configuration-set/alp-marketing-tracked']);
    expect(status).toMatchObject({ verifiedForSending: false, dkim: 'pending', mailFrom: 'pending' });
    expect(status.records).toEqual(dnsRecordsFor('mail.fictional-clinic.example', 'us-east-2', ['tok1', 'tok2', 'tok3']));
    await expect(ses.registerDomain({ domain: 'x.example', tenant: 't', configurationSets: ['alp-transactional'] })).rejects.toThrow('campaign_configuration_set_refused');
  });
});
