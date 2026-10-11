import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiGatewayV2Event } from './aws-identity-api';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({ DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class { constructor(readonly input: Record<string, unknown>) {} },
  QueryCommand: class { constructor(readonly input: Record<string, unknown>) {} },
  PutCommand: class {}, UpdateCommand: class {}, TransactWriteCommand: class {},
  TransactGetCommand: class { constructor(readonly input: Record<string, unknown>) {} },
}));
import { createTelehealthHandler, type TelehealthConfiguration } from './aws-telehealth-requests';
const org = '22222222-2222-4222-8222-222222222222', owner = '11111111-1111-4111-8111-111111111111';
const requestId = '33333333-3333-4333-8333-333333333333', appointmentId = '44444444-4444-4444-8444-444444444444';
const at = Date.parse('2026-10-11T19:00:00.000Z');
const config: TelehealthConfiguration = { tableName: 'fictional-appointments', consumerIssuer: 'https://fictional-consumer.test',
  consumerAudience: 'consumer', workforceIssuer: 'https://fictional-workforce.test', workforceAudience: 'workforce', runtimeMode: 'synthetic',
  phiAllowed: false, zoomEnabled: true, zoomBaaVerified: true, zoomSecretArn: 'fictional-secret-never-read', remindersEnabled: false,
  reminderSender: '', reminderConfigurationSet: '', reminderScheduleGroup: '', reminderSchedulerRoleArn: '', reminderTargetArn: '',
  reminderEventsTopicArn: '', stripeTestEnabled: false, stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '',
  identityApiOrigin: 'https://fictional-api.test', chartAdmissionSecretArn: '' };
const request = () => ({ pk: `ORG#${org}`, sk: `REQ#${requestId}`, requestId, organizationId: org, consumerPersonId: owner,
  appointmentId, version: 1, status: 'scheduled', scheduledStart: '2026-10-11T18:00:00.000Z', scheduledEnd: '2026-10-11T18:30:00.000Z',
  providerMeetingId: '123456789', joinUrl: 'https://zoom.us/j/123456789?pwd=fictional' });
const visit = () => ({ pk: `ORG#${org}`, sk: `VISIT#${appointmentId}`, organizationId: org, appointmentId, requestId,
  consumerPersonId: owner, scheduledStart: request().scheduledStart, scheduledEnd: request().scheduledEnd, version: 2, status: 'in_visit',
  providerMeetingId: request().providerMeetingId, joinUrl: request().joinUrl, startedAt: '2026-10-11T18:01:00.000Z', endedAt: null,
  mutationOperationId: undefined, providerShutdown: { status: 'not_started' }, quickNotes: 'private fictional note', passcode: 'private-passcode' });
function event(body: unknown = { requestId, expectedVersion: 1 }): ApiGatewayV2Event {
  return { routeKey: 'POST /clinical-core/consumer/appointments/join', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: config.consumerIssuer, aud: config.consumerAudience, token_use: 'id',
      sub: 'fictional-consumer', email: 'fictional@example.test', 'custom:person_id': owner, 'custom:organization_id': org,
      'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' } } } } };
}
function setup(row: Record<string, unknown> = request(), opened: Record<string, unknown> | null = visit()) {
  send.mockImplementation(async (command: { input: Record<string, unknown> }) => command.input.TransactItems
    ? { Responses: [{ Item: row }, opened ? { Item: opened } : {}] } : { Items: [row] });
}
beforeEach(() => { send.mockReset(); vi.spyOn(Date, 'now').mockReturnValue(at); setup(); });
afterEach(() => vi.restoreAllMocks());
it('a past-end scheduled request can join only its own practitioner-open visit, without a provider call or private text', async () => {
  const result = await createTelehealthHandler(config)(event()); expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).data).toMatchObject({ protocol: 'appointment-join/1', requestId, organizationId: org,
    appointmentId, requestVersion: 1, visitVersion: 2, authority: 'open_visit', joinUrl: request().joinUrl,
    checkedAt: new Date(at).toISOString(), validUntil: new Date(at + 30_000).toISOString() });
  expect(result.body).not.toContain('private'); expect(result.body).not.toContain('fictional@example.test');
  const snapshot = send.mock.calls.at(-1)![0].input.TransactItems as { Get: { Key: unknown; TableName: string } }[];
  expect(snapshot.map(row => row.Get.Key)).toEqual([{ pk: `ORG#${org}`, sk: `REQ#${requestId}` }, { pk: `ORG#${org}`, sk: `VISIT#${appointmentId}` }]);
});
it('before the end, a scheduled request needs no opened visit, but the check expires at the end boundary', async () => {
  setup({ ...request(), scheduledEnd: new Date(at + 10_000).toISOString() }, null);
  const result = await createTelehealthHandler(config)(event()); expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).data).toMatchObject({ authority: 'scheduled_window', visitVersion: null, validUntil: new Date(at + 10_000).toISOString() });
});
it.each(['scheduled', 'ending', 'ended', 'cancelled'])('past end refuses visit state %s', async status => {
  setup(request(), { ...visit(), status }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('exactly at the scheduled end requires an open visit, not the old scheduled row', async () => {
  setup({ ...request(), scheduledEnd: new Date(at).toISOString() }, null);
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('a known ended visit is refused even before the scheduled end', async () => {
  setup({ ...request(), scheduledEnd: new Date(at + 3_600_000).toISOString() }, { ...visit(), status: 'ended', endedAt: new Date(at - 1000).toISOString() });
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it.each([{ consumerPersonId: appointmentId }, { organizationId: appointmentId }, { requestId: appointmentId }, { appointmentId: requestId },
  { providerMeetingId: '987654321' }, { joinUrl: 'https://zoom.us/j/987654321' }, { startedAt: null }, { startedAt: new Date(at + 1).toISOString() },
  { endedAt: new Date(at - 1).toISOString() }, { providerShutdown: { status: 'pending' } }, { providerShutdown: { status: 'failed' } },
  { mutationOperationId: requestId }, { scheduledEnd: new Date(at - 1).toISOString() }])('refuses an unbound or no-longer-open visit %j', async change => {
  setup(request(), { ...visit(), ...change }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it.each(['requested', 'awaiting_provider', 'reschedule_requested', 'cancelled'])('request %s cannot authorize a link', async status => {
  setup({ ...request(), status }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('refuses a changed version or a pending appointment mutation', async () => {
  setup({ ...request(), version: 2 }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
  setup({ ...request(), mutationOperationId: appointmentId }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('another owner receives no link or visit state', async () => {
  setup({ ...request(), consumerPersonId: appointmentId }); const result = await createTelehealthHandler(config)(event());
  expect(result.statusCode).toBe(403); expect(result.body).not.toContain('zoom'); expect(send).toHaveBeenCalledOnce();
});
it('an unavailable or malformed transactional read is never counted as an open visit', async () => {
  send.mockResolvedValueOnce({ Items: [request()] }).mockRejectedValueOnce(new Error('fictional store failed'));
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503);
  send.mockResolvedValueOnce({ Items: [request()] }).mockResolvedValueOnce({});
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503);
});
it('a cancellation after discovery is refused by the final same-table transactional snapshot', async () => {
  send.mockResolvedValueOnce({ Items: [request()] }).mockResolvedValueOnce({ Responses: [{ Item: { ...request(), status: 'cancelled' } }, { Item: visit() }] });
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('the clock is evaluated after the store answer, so crossing the end during a read requires an open visit', async () => {
  vi.mocked(Date.now).mockReturnValue(at - 3_600_000);
  send.mockResolvedValueOnce({ Items: [{ ...request(), scheduledEnd: new Date(at - 1000).toISOString() }] }).mockImplementationOnce(async () => {
    vi.mocked(Date.now).mockReturnValue(at); return { Responses: [{ Item: { ...request(), scheduledEnd: new Date(at - 1000).toISOString() } }, {}] };
  });
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it.each(['http://zoom.us/j/123', 'https://evil.test/j/123', 'https://zoom.us:444/j/123', 'https://user@zoom.us/j/123'])('refuses unsafe join URL %s', async joinUrl => {
  setup({ ...request(), joinUrl }, { ...visit(), joinUrl }); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409);
});
it('provider disabled and PHI-disabled production remain refused', async () => {
  expect((await createTelehealthHandler({ ...config, zoomEnabled: false })(event())).statusCode).toBe(503);
  expect((await createTelehealthHandler({ ...config, runtimeMode: 'production' })(event())).statusCode).toBe(503);
});
