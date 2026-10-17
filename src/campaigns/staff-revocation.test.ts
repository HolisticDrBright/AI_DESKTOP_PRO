import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorkforceRequest, WorkforceResponse } from './contract';
import { FORM_MIN_MS } from './public';
import { campaignRuntime } from './runtime';
import { createDynamoStaffRevocationSignal, STAFF_REVOCATION_SIGNAL_CONTRACT } from './staff-revocation';
import { fictionalEngine, tokenFrom } from './testing';

/**
 * A practitioner login revoked for a suspected compromise, at the campaign API's staff route. The engine authorizes staff
 * from the token's claims and its own role grants, so before this route read the revocation signal a revoked login kept
 * every staff operation until its ID token expired (the pinned GAP test at daaf6291,
 * events-and-routes.test.ts::GAP pinned). Now the route reads the signal before any operation, and refuses when it
 * cannot. Fictional practices, people, subjects and addresses only.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const COLLEAGUE = { practiceId: PRACTICE, personId: '31111111-1111-4111-8111-111111111111', subject: 'fictional-subject-31111111-1111-4111-8111-111111111111', email: 'colleague@fictional-clinic.example', name: 'Fictional Colleague' };
const SUBJECT = { admin: 'fictional-workforce-admin-0001', colleague: 'fictional-workforce-colleague-0002' };
type Who = typeof ADMIN;
const claims = (who: Who, subject: unknown, extra: Record<string, unknown> = {}) => ({ authorizer: { jwt: { claims: {
  ...(subject === undefined ? {} : { sub: subject }), 'custom:organization_id': who.practiceId, 'custom:person_id': who.personId, email: who.email,
  exp: Date.now() / 1000 + 3600, ...extra } } } });
const done = (r: WorkforceResponse) => { if (r.action !== 'done') throw new Error(r.action); return r.refreshed; };

/** A ready practice with one confirmed subscriber, the starter emails, a colleague with the marketing role, and an
 * approved, test-sent broadcast waiting to be scheduled. */
async function practice(options: Parameters<typeof fictionalEngine>[0] = {}) {
  const e = fictionalEngine(options);
  const ask = await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
  const page = await e.publicSide.joinPage('fictional-clinic', 'longevity-program');
  e.advance(FORM_MIN_MS + 10);
  await e.publicSide.join({ practice: 'fictional-clinic', program: 'longevity-program', email: 'avery@fictional.example', consent: 'yes', formToken: page!.formToken });
  await e.publicSide.confirm(tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm'));
  done(await ask({ action: 'install_starter', programKey: 'longevity-program' }));
  done(await ask({ action: 'grant_role', personId: COLLEAGUE.personId, role: 'marketing', name: COLLEAGUE.name }));
  const o = done(await ask({ action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Fictional update',
    subject: 'An update about the Longevity Program', blocks: [{ type: 'paragraph', text: 'Hello {{first_name|there}}, the program now offers evening consultations.' }, { type: 'button', label: 'Read about the program' }] } }));
  const t = o.templates.find(x => x.name === 'Fictional update')!;
  const b = done(await ask({ action: 'save_broadcast', broadcastId: null, programKey: 'longevity-program', templateId: t.templateId })).broadcasts[0]!;
  done(await ask({ action: 'approve_template', templateId: t.templateId, version: t.version }));
  done(await ask({ action: 'test_send', templateId: t.templateId, broadcastId: b.broadcastId }));
  const staff = async (who: Who, subject: unknown, body: unknown) => {
    const reply = await e.http({ routeKey: 'POST /campaigns/workforce', body: JSON.stringify(body), requestContext: claims(who, subject) });
    return { status: reply.statusCode, body: JSON.parse(reply.body) as { data?: unknown; error?: string; detail?: string } };
  };
  /** Everything the engine holds and has sent: what a refused request must leave exactly as it was. */
  const state = () => JSON.stringify({ store: [...e.store.dump()], outbox: e.ses.outbox.length });
  return { e, ask, staff, state, template: t, broadcast: b };
}

/** One request per kind of staff operation: read, export, edit, approve, send, schedule, and grant. */
const operations = (p: Awaited<ReturnType<typeof practice>>): Array<[string, WorkforceRequest]> => [
  ['read', { action: 'overview' }],
  ['status', { action: 'status' }],
  ['export', { action: 'contacts', programKey: 'longevity-program' }],
  ['edit', { action: 'save_template', templateId: null, expectedVersion: 0, draft: { programKey: 'longevity-program', kind: 'broadcast', name: 'Edited by a revoked login',
    subject: 'Edited', blocks: [{ type: 'paragraph', text: 'Fictional text.' }] } }],
  ['approve', { action: 'approve_template', templateId: p.template.templateId, version: p.template.version }],
  ['send', { action: 'test_send', templateId: p.template.templateId, broadcastId: p.broadcast.broadcastId }],
  ['schedule', { action: 'schedule_broadcast', broadcastId: p.broadcast.broadcastId, sendAt: p.e.now().toISOString() }],
  ['sequence', { action: 'set_sequence_status', programKey: 'longevity-program', expectedVersion: 1, status: 'active' }],
  ['grant', { action: 'grant_role', personId: '41111111-1111-4111-8111-111111111111', role: 'marketing_admin', name: 'Fictional Accomplice' }],
];

describe('the engine on its own has no idea a login was revoked: only the route can stop it', () => {
  it('the staff operations themselves serve a revoked login, so every way to them must pass the route', async () => {
    const p = await practice();
    p.e.revocations.revoke(SUBJECT.admin);
    // The engine's staff handler takes a practice and a person, never a subject; it reads no revocation.
    expect(await p.e.staff.handle(ADMIN, { action: 'contacts', programKey: 'longevity-program' })).toMatchObject({ action: 'contacts' });
    // Outside its own definition, the staff handler is built only by the HTTP route and by the fictional test engine.
    const callers = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter(f => f.isFile() && /\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name))
      .filter(f => /(?<!function )createWorkforceCampaigns\(/.test(readFileSync(`${f.parentPath}/${f.name}`, 'utf8')))
      .map(f => `${f.parentPath}/${f.name}`.replace(/\\/g, '/')).sort();
    expect(callers).toEqual(['src/campaigns/http.ts', 'src/campaigns/testing.ts']);
  });
});

describe('a revoked login at the staff route', () => {
  it('is refused for every kind of staff operation, before anything is read, changed or sent', async () => {
    const p = await practice();
    p.e.revocations.revoke(SUBJECT.admin);
    for (const [kind, body] of operations(p)) {
      const before = p.state();
      expect([kind, await p.staff(ADMIN, SUBJECT.admin, body)]).toEqual([kind, { status: 403, body: { error: 'forbidden', detail: 'identity_refused' } }]);
      expect([kind, p.state()]).toEqual([kind, before]);
    }
  });

  it('never reaches the store: the signal is read first', async () => {
    const p = await practice();
    p.e.revocations.revoke(SUBJECT.admin);
    const practiceStore = p.e.deps.store.practice;
    p.e.deps.store.practice = () => { throw new Error('the store was reached'); };
    try {
      expect((await p.staff(ADMIN, SUBJECT.admin, { action: 'overview' })).status).toBe(403);
    } finally { p.e.deps.store.practice = practiceStore; }
  });

  it('is refused on its next request with the same token, revoked between two requests', async () => {
    const p = await practice();
    expect((await p.staff(ADMIN, SUBJECT.admin, { action: 'contacts', programKey: 'longevity-program' })).status).toBe(200);
    p.e.revocations.revoke(SUBJECT.admin);
    expect((await p.staff(ADMIN, SUBJECT.admin, { action: 'contacts', programKey: 'longevity-program' }))).toEqual({ status: 403, body: { error: 'forbidden', detail: 'identity_refused' } });
  });

  it('is refused whatever practice or person its token names: the signal is about the login', async () => {
    const p = await practice();
    p.e.revocations.revoke(SUBJECT.admin);
    expect((await p.staff(COLLEAGUE, SUBJECT.admin, { action: 'overview' })).status).toBe(403);
    expect((await p.staff({ ...ADMIN, practiceId: '22222222-2222-4222-8222-222222222222' }, SUBJECT.admin, { action: 'overview' })).status).toBe(403);
  });

  it('does not touch a colleague in the same practice, who keeps every operation', async () => {
    const p = await practice();
    p.e.revocations.revoke(SUBJECT.admin);
    expect((await p.staff(COLLEAGUE, SUBJECT.colleague, { action: 'overview' })).status).toBe(200);
    expect((await p.staff(COLLEAGUE, SUBJECT.colleague, { action: 'contacts', programKey: 'longevity-program' })).status).toBe(200);
    const scheduled = await p.staff(COLLEAGUE, SUBJECT.colleague, { action: 'schedule_broadcast', broadcastId: p.broadcast.broadcastId, sendAt: p.e.now().toISOString() });
    expect(scheduled.status).toBe(200);
  });
});

describe('an outage never reads as "not revoked"', () => {
  it('a signal that cannot be read refuses every staff operation with 503, and changes nothing', async () => {
    const p = await practice();
    p.e.revocations.outage(true);
    for (const [kind, body] of operations(p)) {
      const before = p.state();
      expect([kind, await p.staff(ADMIN, SUBJECT.admin, body)]).toEqual([kind, { status: 503, body: { error: 'unavailable', detail: 'staff_revocation_unavailable' } }]);
      expect([kind, p.state()]).toEqual([kind, before]);
    }
    p.e.revocations.outage(false);
    expect((await p.staff(ADMIN, SUBJECT.admin, { action: 'overview' })).status).toBe(200);
  });

  it('a deployment with no signal configured refuses every staff operation with 503', async () => {
    const e = fictionalEngine({ staffRevocation: 'unconfigured' });
    const reply = await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: claims(ADMIN, SUBJECT.admin) });
    expect([reply.statusCode, JSON.parse(reply.body)]).toEqual([503, { error: 'unavailable', detail: 'staff_revocation_unconfigured' }]);
  });

  it('a signal that throws anything else is still 503, never an answer', async () => {
    const p = await practice();
    p.e.deps.staffRevocation = { revoked: async () => { throw new TypeError('fictional fault'); } };
    expect(await p.staff(ADMIN, SUBJECT.admin, { action: 'overview' })).toEqual({ status: 503, body: { error: 'unavailable' } });
  });

  it('a token with no subject, or a malformed one, is refused without reading the signal', async () => {
    const p = await practice();
    const reads = p.e.revocations.reads.length;
    for (const subject of [undefined, '', 'short', 'x'.repeat(129), 'has space here', 42, null]) {
      expect([subject, (await p.staff(ADMIN, subject, { action: 'overview' })).status]).toEqual([subject, 403]);
    }
    expect(p.e.revocations.reads.length).toBe(reads);
  });
});

describe('the public routes never read the signal', () => {
  it('sign-up, confirm, unsubscribe and the join page work with the signal down, and with none configured', async () => {
    for (const mode of ['down', 'unconfigured'] as const) {
      const e = fictionalEngine(mode === 'unconfigured' ? { staffRevocation: 'unconfigured' } : {});
      await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
      if (mode === 'down') e.revocations.outage(true);
      const page = await e.http({ routeKey: 'GET /campaigns/public/join/{practice}/{program}', pathParameters: { practice: 'fictional-clinic', program: 'longevity-program' } });
      expect([mode, page.statusCode]).toEqual([mode, 200]);
      const open = await e.http({ routeKey: 'GET /campaigns/public/signup-open/{practice}/{program}', pathParameters: { practice: 'fictional-clinic', program: 'longevity-program' } });
      expect(JSON.parse(open.body)).toEqual({ data: { open: true } });
      e.advance(FORM_MIN_MS + 10);
      const join = await e.http({ routeKey: 'POST /campaigns/public/join', body: JSON.stringify({ practice: 'fictional-clinic', program: 'longevity-program',
        email: `${mode}@fictional.example`, consent: 'yes', formToken: JSON.parse(page.body).data.formToken }) });
      expect([mode, join.statusCode]).toEqual([mode, 202]);
      const confirm = await e.http({ routeKey: 'POST /campaigns/public/confirm', body: JSON.stringify({ token: tokenFrom(e.ses.outbox.at(-1)!.text, '/join/confirm') }) });
      expect([mode, JSON.parse(confirm.body)]).toEqual([mode, { data: { outcome: 'confirmed' } }]);
      expect(e.revocations.reads).toEqual([]);
    }
  });
});

describe('the DynamoDB signal, at its SDK boundary', () => {
  const client = (reply: unknown) => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    return { calls, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: command.constructor.name, input: command.input });
      if (reply instanceof Error) throw reply;
      return reply;
    } };
  };
  it('reads one item by subject, strongly consistent, from its own table only; any item at all is a revocation', async () => {
    for (const [reply, revoked] of [[{}, false], [{ Item: { subject: SUBJECT.admin } }, true], [{ Item: {} }, true], [{ Item: { subject: 'other', contract: 'unknown' } }, true]] as const) {
      const c = client(reply);
      expect(await createDynamoStaffRevocationSignal({ client: c as never, tableName: 'alp-campaign-staff-revocations' }).revoked(SUBJECT.admin)).toBe(revoked);
      expect(c.calls).toEqual([{ name: 'GetCommand', input: { TableName: 'alp-campaign-staff-revocations', Key: { subject: SUBJECT.admin }, ConsistentRead: true,
        ProjectionExpression: '#s', ExpressionAttributeNames: { '#s': 'subject' } } }]);
    }
  });
  it('a failed or timed-out read is unavailable, never "not revoked"; a malformed subject is refused without a read', async () => {
    for (const name of ['ResourceNotFoundException', 'AccessDeniedException', 'ProvisionedThroughputExceededException', 'TimeoutError', 'AbortError', 'InternalServerError']) {
      const c = client(Object.assign(new Error('fictional'), { name }));
      await expect(createDynamoStaffRevocationSignal({ client: c as never, tableName: 't-1' }).revoked(SUBJECT.admin)).rejects.toMatchObject({ category: 'unavailable', detail: 'staff_revocation_unavailable' });
    }
    const c = client({});
    await expect(createDynamoStaffRevocationSignal({ client: c as never, tableName: 't-1' }).revoked('no')).rejects.toMatchObject({ category: 'forbidden' });
    expect(c.calls).toEqual([]);
    const slow = { send: (_c: unknown, options: { abortSignal: AbortSignal }) => new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) };
    await expect(createDynamoStaffRevocationSignal({ client: slow as never, tableName: 't-1', timeoutMs: 20 }).revoked(SUBJECT.admin)).rejects.toMatchObject({ category: 'unavailable' });
  });
  it('names its contract', () => { expect(STAFF_REVOCATION_SIGNAL_CONTRACT).toBe('staff-revocation-signal/1'); });
});

describe('configuration and the template', () => {
  const env = { CAMPAIGN_ENGINE_ENABLED: 'true', CAMPAIGN_SITE_ORIGIN: 'https://clinic.fictional.example', CAMPAIGN_CONFIGURATION_SET: 'alp-marketing',
    CAMPAIGN_TRACKED_CONFIGURATION_SET: 'alp-marketing-tracked', CAMPAIGN_FROM_LOCAL_PART: 'updates', CAMPAIGN_TABLE_NAME: 'alp-campaigns',
    CAMPAIGN_KEY_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:111122223333:secret:fictional', AWS_REGION: 'us-east-2', CAMPAIGN_ACCOUNT_ID: '111122223333' };
  it('the signal table is read from CAMPAIGN_STAFF_REVOCATION_TABLE, and is absent (staff refused) when it is not set', () => {
    expect(campaignRuntime(env)).toMatchObject({ enabled: true, staffRevocationTable: null });
    expect(campaignRuntime({ ...env, CAMPAIGN_STAFF_REVOCATION_TABLE: 'alp-campaign-staff-revocations' })).toMatchObject({ staffRevocationTable: 'alp-campaign-staff-revocations' });
    expect(() => campaignRuntime({ ...env, CAMPAIGN_STAFF_REVOCATION_TABLE: 'bad name!' })).toThrow('campaign_configuration_incomplete:CAMPAIGN_STAFF_REVOCATION_TABLE');
  });
  it('declares the signal table: keyed by subject, retained, recoverable, encrypted; read-only for the API function, nothing for the others', () => {
    type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
    const template = JSON.parse(readFileSync('infra/campaigns/campaign-engine.json', 'utf8')) as { Resources: Record<string, Resource>; Outputs: Record<string, unknown> };
    const table = template.Resources.CampaignStaffRevocationTable!;
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.Properties).toMatchObject({ TableName: 'alp-campaign-staff-revocations', KeySchema: [{ AttributeName: 'subject', KeyType: 'HASH' }], DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, SSESpecification: { SSEEnabled: true, SSEType: 'KMS' } });
    // Its own AWS-managed key, never the campaign key: the revocation's writer is granted this table alone.
    expect(JSON.stringify(table.Properties)).not.toContain('CampaignKey');
    const mentions = Object.entries(template.Resources).filter(([name, r]) => name !== 'CampaignStaffRevocationTable' && JSON.stringify(r).includes('CampaignStaffRevocationTable'));
    // Read by the API (every staff operation) and the sender (every send, send-authority/1); the SES events function never.
    expect(mentions.map(([name]) => name).sort()).toEqual(['CampaignApiFunction', 'CampaignApiRole', 'CampaignSenderFunction', 'CampaignSenderRole']);
    for (const role of ['CampaignApiRole', 'CampaignSenderRole']) {
      const statements = JSON.stringify(template.Resources[role]!.Properties.Policies);
      expect(statements).toContain('{"Sid":"ReadStaffRevocationSignal","Effect":"Allow","Action":"dynamodb:GetItem","Resource":{"Fn::GetAtt":["CampaignStaffRevocationTable","Arn"]}}');
    }
    for (const fn of ['CampaignApiFunction', 'CampaignSenderFunction']) {
      expect(((template.Resources[fn]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables).CAMPAIGN_STAFF_REVOCATION_TABLE).toEqual({ Ref: 'CampaignStaffRevocationTable' });
    }
    expect(template.Outputs.CampaignStaffRevocationTableArn).toMatchObject({ Value: { 'Fn::GetAtt': ['CampaignStaffRevocationTable', 'Arn'] } });
  });
});
