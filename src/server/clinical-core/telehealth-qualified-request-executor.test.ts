import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { createTelehealthHandler, createTelehealthQualificationRequestExecutor, telehealthRequestDigest,
  TELEHEALTH_PUBLIC_ROUTE_POOLS, TelehealthRequestAdmissionError,
  type TelehealthActor, type TelehealthConfiguration, type TelehealthRequestPorts } from './aws-telehealth-requests';
import type { ApiGatewayV2Event } from './aws-identity-api';
const owner = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const second = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slotId = '33333333-3333-4333-8333-333333333333';
const at = Date.parse('2026-10-11T22:00:00.000Z');
const config: TelehealthConfiguration = { tableName: 'fictional-qualification', consumerIssuer: 'https://fictional-consumer.test', consumerAudience: 'consumer',
  workforceIssuer: 'https://fictional-workforce.test', workforceAudience: 'workforce', runtimeMode: 'synthetic', phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: '', remindersEnabled: false, reminderSender: '', reminderConfigurationSet: '',
  reminderScheduleGroup: '', reminderSchedulerRoleArn: '', reminderTargetArn: '', reminderEventsTopicArn: '', stripeTestEnabled: false,
  stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '', identityApiOrigin: 'https://fictional-api.test', chartAdmissionSecretArn: '' };
const actor = (pool: 'consumer' | 'workforce' = 'consumer', personId = owner): TelehealthActor => ({ personId, organizationId: org,
  subject: `fictional-${pool}`, pool, email: 'fictional@example.test', bearer: 'fictional.signed.token' });
function event(routeKey = 'GET /clinical-core/consumer/appointments/requests', body: unknown = {}): ApiGatewayV2Event {
  return { routeKey, body: JSON.stringify(body), headers: { authorization: 'Bearer fictional.signed.token', 'content-type': 'application/json' },
    requestContext: { authorizer: { jwt: { claims: { 'custom:person_id': second, 'custom:organization_id': second, sub: 'FORGED',
      'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' } } } } };
}
function setup(who = actor(), read: (command: unknown, options?: unknown) => Promise<unknown> = async () => ({ Items: [] })) {
  const document = { send: vi.fn(read) }, disabled = { send: vi.fn(async () => { throw Error('fictional provider unavailable'); }) };
  const ports: TelehealthRequestPorts = { document: document as unknown as TelehealthRequestPorts['document'],
    secrets: disabled as unknown as TelehealthRequestPorts['secrets'], ses: disabled as unknown as TelehealthRequestPorts['ses'],
    scheduler: disabled as unknown as TelehealthRequestPorts['scheduler'], fetch: vi.fn(async () => { throw Error('fictional outbound forbidden'); }) };
  const receipts = new WeakSet<object>();
  const admit = vi.fn(async (request: { event: ApiGatewayV2Event; pool: 'consumer' | 'workforce'; requestSha256: string }) => {
    const receipt = Object.freeze({ contract: 'telehealth-native-request-admission/1' as const, requestSha256: request.requestSha256,
      actor: { ...who, pool: request.pool }, ports, issuedAt: at, validUntil: at + 30_000 });
    receipts.add(receipt); return receipt;
  });
  const admission = { admit, isAdmitted: (r: unknown) => !!r && typeof r === 'object' && receipts.has(r) };
  return { ports, document, disabled, receipts, admission, handler: createTelehealthQualificationRequestExecutor(config, admission) };
}
let fallback: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(at);
  fallback = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockRejectedValue(Error('shared client must not be used'));
  vi.spyOn(SecretsManagerClient.prototype, 'send').mockRejectedValue(Error('shared secret client must not be used'));
  vi.spyOn(SESv2Client.prototype, 'send').mockRejectedValue(Error('shared email client must not be used'));
  vi.spyOn(SchedulerClient.prototype, 'send').mockRejectedValue(Error('shared scheduler must not be used'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('global fetch must not be used'));
});
afterEach(() => vi.restoreAllMocks());
it('uses the admitted owner directly, never the forwarded authorizer or shared clients', async () => {
  const s = setup(); const e = event(), original = structuredClone(e);
  expect((await s.handler(e)).statusCode).toBe(200);
  expect(e).toEqual(original); expect(s.admission.admit.mock.calls[0][0].event.requestContext).toBeUndefined();
  const command = s.document.send.mock.calls[0][0] as QueryCommand;
  expect(command.input.ExpressionAttributeValues?.[':person']).toBe(`PERSON#${owner}`);
  expect(fallback).not.toHaveBeenCalled(); expect(s.disabled.send).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(Object.entries(TELEHEALTH_PUBLIC_ROUTE_POOLS))('every public route %s reaches its exact pool admission before domain execution', async (route, pool) => {
  const s = setup(); await s.handler(event(route));
  expect(s.admission.admit).toHaveBeenCalledOnce(); expect(s.admission.admit.mock.calls[0][0].pool).toBe(pool);
  expect(fallback).not.toHaveBeenCalled(); expect(s.disabled.send).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it.each(['POST /clinical-core/webhooks/stripe/appointments', 'internal', 'GET /clinical-core/consumer/appointments/requests/other'])('does not admit internal, webhook or unregistered route %s', async route => {
  const s = setup(); expect((await s.handler(event(route))).statusCode).toBe(404);
  expect(s.admission.admit).not.toHaveBeenCalled(); expect(s.document.send).not.toHaveBeenCalled();
});
it('no route can turn a public event into an internal reminder or SNS notification', async () => {
  const s = setup(); const e = Object.assign(event(), { internalEvent: 'send_appointment_reminder', Records: [{ EventSource: 'aws:sns' }] });
  expect((await s.handler(e)).statusCode).toBe(200); expect(s.document.send).toHaveBeenCalledOnce();
  expect(s.disabled.send).not.toHaveBeenCalled();
});
it.each(['reauth_required', 'identity_refused', 'consent_required', 'release_required', 'service_unavailable'] as const)('preserves authored admission refusal %s without touching storage', async category => {
  const s = setup(); s.admission.admit.mockRejectedValue(new TelehealthRequestAdmissionError(category));
  const answer = await s.handler(event()); expect(answer.statusCode).toBe(category === 'reauth_required' ? 401 : category === 'identity_refused' ? 403 : category === 'consent_required' ? 409 : 503);
  expect(JSON.parse(answer.body)).toEqual({ error: category, execution: 'qualification', phiAllowed: false }); expect(s.document.send).not.toHaveBeenCalled();
});
it('missing admission, forged receipt or another request receipt cannot invoke a store', async () => {
  expect(() => createTelehealthQualificationRequestExecutor(config, undefined as never)).toThrow('telehealth_qualification_executor_invalid');
  const s = setup(); s.admission.isAdmitted = () => false;
  expect((await s.handler(event())).statusCode).toBe(403); expect(s.document.send).not.toHaveBeenCalled();
  const valid = setup(); const prior = await valid.admission.admit({ event: event(), pool: 'consumer', requestSha256: telehealthRequestDigest(event()) });
  valid.admission.admit.mockResolvedValue(prior);
  expect((await valid.handler(event('GET /clinical-core/workforce/appointments/slots'))).statusCode).toBe(403); expect(valid.document.send).not.toHaveBeenCalled();
});
it.each([{ runtimeMode: 'production' }, { phiAllowed: true }, { zoomEnabled: true }, { zoomBaaVerified: true },
  { zoomSecretArn: 'unreviewed' }, { remindersEnabled: true }, { stripeTestEnabled: true }, { stripeSecretArn: 'unreviewed' }, { chartAdmissionSecretArn: 'unreviewed' }])('cannot bypass activation or provider restrictions through configuration %j', change => {
  expect(() => createTelehealthQualificationRequestExecutor({ ...config, ...change } as TelehealthConfiguration, setup().admission)).toThrow();
});
it('historical production remains PHI-disabled and does not call the qualification admission port', async () => {
  const s = setup(); const result = await createTelehealthHandler({ ...config, runtimeMode: 'production' })(event());
  expect(result.statusCode).toBe(503); expect(JSON.parse(result.body).error).toBe('production_not_activated');
  expect(s.admission.admit).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
});
it.each(['document', 'secrets', 'ses', 'scheduler', 'fetch'] as const)('missing port %s is refused without default fallback', async key => {
  const s = setup(); Reflect.deleteProperty(s.ports, key);
  expect((await s.handler(event())).statusCode).toBe(503); expect(fallback).not.toHaveBeenCalled(); expect(s.document.send).not.toHaveBeenCalled();
});
it('two overlapping requests keep owners and transports isolated despite interleaved awaits', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const a = setup(actor(), async () => { await wait; return { Items: [] }; });
  const b = setup(actor('consumer', second), async () => { release(); return { Items: [] }; });
  expect((await Promise.all([a.handler(event()), b.handler(event())])).map(r => r.statusCode)).toEqual([200, 200]);
  expect((a.document.send.mock.calls[0][0] as QueryCommand).input.ExpressionAttributeValues?.[':person']).toBe(`PERSON#${owner}`);
  expect((b.document.send.mock.calls[0][0] as QueryCommand).input.ExpressionAttributeValues?.[':person']).toBe(`PERSON#${second}`);
  expect(fallback).not.toHaveBeenCalled();
});
it('an expired or future receipt and a backward clock cannot publish a result', async () => {
  const expired = setup(); vi.mocked(Date.now).mockReturnValue(at + 30_000);
  expect((await expired.handler(event())).statusCode).toBe(403); expect(expired.document.send).not.toHaveBeenCalled();
  vi.mocked(Date.now).mockReturnValue(at - 1); expect((await setup().handler(event())).statusCode).toBe(403);
  vi.mocked(Date.now).mockReturnValue(at);
  const backward = setup(actor(), async () => { vi.mocked(Date.now).mockReturnValue(at - 1); return { Items: [] }; });
  expect((await backward.handler(event())).statusCode).toBe(503);
});
it('an answer arriving after expiry is unavailable, never a success or a claim that a write rolled back', async () => {
  const s = setup(actor(), async () => { vi.mocked(Date.now).mockReturnValue(at + 30_000); return { Items: [] }; });
  const answer = await s.handler(event()); expect(answer.statusCode).toBe(503); expect(answer.body).not.toContain('rolled');
});
it('an admission-side event mutation is refused; forwarded claims cannot change the bound hash', async () => {
  const s = setup(); const admit = s.admission.admit.getMockImplementation()!;
  s.admission.admit.mockImplementation(async req => { const result = await admit(req); req.event.body = '{"changed":true}'; return result; });
  expect((await s.handler(event())).statusCode).toBe(403); expect(s.document.send).not.toHaveBeenCalled();
  expect(telehealthRequestDigest(event())).toBe(telehealthRequestDigest({ ...event(), requestContext: undefined }));
});
it('base64 bodies are refused before admission and header duplication cannot pass the exact bearer binding', async () => {
  const s = setup(); expect((await s.handler({ ...event(), isBase64Encoded: true })).statusCode).toBe(400); expect(s.admission.admit).not.toHaveBeenCalled();
  expect((await s.handler({ ...event(), headers: { ...event().headers, Authorization: 'Bearer fictional.signed.token' } })).statusCode).toBe(403);
  expect(s.document.send).not.toHaveBeenCalled();
});
it('configuration and admitted event are captured, not exposed to later caller mutation', async () => {
  const s = setup(); const mutable = { ...config }; const run = createTelehealthQualificationRequestExecutor(mutable, s.admission);
  mutable.tableName = 'wrong-table'; expect((await run(event())).statusCode).toBe(200);
  expect((s.document.send.mock.calls[0][0] as QueryCommand).input.TableName).toBe(config.tableName);
});
it('SDK errors and submitted content cannot leak into refusal bodies', async () => {
  const s = setup(actor(), async () => { throw Error('Bearer private-token patient@example.test health-payload'); });
  const answer = await s.handler(event()); expect(answer.statusCode).toBe(503);
  expect(answer.body).not.toMatch(/private-token|patient@|health-payload/); expect(answer.headers['cache-control']).toBe('no-store');
});
it('the native execution seam preserves existing conditional hold publication rather than a read-then-unconditional write', async () => {
  const s = setup(actor(), async command => command instanceof QueryCommand ? { Items: [{ pk: `ORG#${org}`, sk: `SLOT#${slotId}`,
    slotId, organizationId: org, status: 'available', visitTypes: ['follow_up'], timeZone: 'America/Los_Angeles',
    start: new Date(at + 86_400_000).toISOString(), end: new Date(at + 88_200_000).toISOString(),
    priceMinor: 0, currency: 'USD', cancellationPolicy: 'Fictional policy.', cancellationWindowHours: 24 }] } : {});
  const answer = await s.handler(event('POST /clinical-core/consumer/appointments/holds', { slotId, visitType: 'follow_up' }));
  expect(answer.statusCode).toBe(201);
  const update = s.document.send.mock.calls.find(([c]) => c instanceof UpdateCommand)![0] as UpdateCommand;
  expect(update.input.ConditionExpression).toBe('#status=:available OR (#status=:held AND holdExpiresAt<=:now)');
  expect(update.input.ExpressionAttributeValues?.[':person']).toBe(owner); expect(fallback).not.toHaveBeenCalled();
});
it('request-local ports stay closed for background work after a response', async () => {
  let release!: () => void, background!: Promise<{ statusCode: number }>;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const validHistorical = event();
  validHistorical.requestContext = { authorizer: { jwt: { claims: { iss: config.consumerIssuer, aud: config.consumerAudience,
    token_use: 'id', sub: 'fictional-consumer', email: actor().email, 'custom:person_id': owner, 'custom:organization_id': org,
    'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' } } } };
  const s = setup(actor(), async () => {
    // Register within the real ALS scope, but resume after it is revoked.
    background = wait.then(() => createTelehealthHandler(config)(validHistorical));
    return { Items: [] };
  });
  expect((await s.handler(event())).statusCode).toBe(200);
  release(); expect((await background).statusCode).toBe(503);
  expect(s.document.send).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
});
it('historical Lambda and build do not silently install this unqualified seam', () => {
  const lambda = readFileSync(new URL('./aws-telehealth-requests-lambda.ts', import.meta.url), 'utf8');
  expect(lambda).not.toContain('createTelehealthQualificationRequestExecutor');
  expect(lambda).toContain('createTelehealthHandler');
});
