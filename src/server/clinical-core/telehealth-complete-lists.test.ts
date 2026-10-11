import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiGatewayV2Event } from './aws-identity-api';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  QueryCommand: class QueryCommand { constructor(readonly input: Record<string, unknown>) {} },
  GetCommand: class GetCommand { constructor(readonly input: Record<string, unknown>) {} },
  PutCommand: class PutCommand { constructor(readonly input: Record<string, unknown>) {} },
  UpdateCommand: class UpdateCommand { constructor(readonly input: Record<string, unknown>) {} },
  TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: Record<string, unknown>) {} },
}));
import { createTelehealthHandler, type TelehealthConfiguration } from './aws-telehealth-requests';
const org = '22222222-2222-4222-8222-222222222222', person = '11111111-1111-4111-8111-111111111111';
const foreignOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config: TelehealthConfiguration = {
  tableName: 'fictional-appointments', consumerIssuer: 'https://fictional-consumer.test', consumerAudience: 'consumer',
  workforceIssuer: 'https://fictional-workforce.test', workforceAudience: 'workforce', runtimeMode: 'synthetic', phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: '', remindersEnabled: false, reminderSender: '',
  reminderConfigurationSet: '', reminderScheduleGroup: '', reminderSchedulerRoleArn: '', reminderTargetArn: '', reminderEventsTopicArn: '',
  stripeTestEnabled: false, stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '', identityApiOrigin: 'https://fictional-api.test', chartAdmissionSecretArn: '',
};
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-3333-4333-8333-333333333333`;
const slot = (n: number) => {
  const start = new Date(Date.now() + 86_400_000 + n * 3_600_000).toISOString();
  return { pk: `ORG#${org}`, sk: `SLOT#${start}#${id(n)}`, organizationId: org, slotId: id(n), start,
    end: new Date(+new Date(start) + 2_700_000).toISOString(), timeZone: 'America/Los_Angeles', visitTypes: ['follow_up'],
    priceMinor: 0, currency: 'USD', cancellationPolicy: 'Fictional policy only.', cancellationWindowHours: 24,
    status: 'available', heldBy: null, holdId: null, holdExpiresAt: null, createdAt: start, createdBy: 'fictional-workforce' };
};
const appointment = (n: number, organizationId = org) => ({ pk: `ORG#${organizationId}`, sk: `REQ#${id(n)}`,
  gsi1pk: `PERSON#${person}`, gsi1sk: `REQ#2026-10-11T00:00:00.000Z#${id(n)}`, organizationId,
  consumerPersonId: person, requestId: id(n), status: 'requested', version: 1, consumerEmail: 'fictional@example.test' });
const cases = [
  { name: 'consumer availability', route: 'POST /clinical-core/consumer/appointments/availability', body: { visitType: 'follow_up' }, row: slot, index: false },
  { name: 'workforce slots', route: 'GET /clinical-core/workforce/appointments/slots', body: undefined, row: slot, index: false },
  { name: 'consumer appointments', route: 'GET /clinical-core/consumer/appointments/requests', body: undefined, row: appointment, index: true },
  { name: 'workforce appointments', route: 'GET /clinical-core/workforce/appointments/requests', body: undefined, row: appointment, index: false },
] as const;
function event(routeKey: string, body?: unknown): ApiGatewayV2Event {
  const workforce = routeKey.includes('/workforce/');
  return { routeKey, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { authorizer: { jwt: { claims: {
      iss: workforce ? config.workforceIssuer : config.consumerIssuer, aud: workforce ? config.workforceAudience : config.consumerAudience,
      token_use: 'id', sub: workforce ? 'fictional-workforce' : 'fictional-consumer', email: 'fictional@example.test',
      'custom:person_id': person, 'custom:organization_id': org, 'custom:synthetic_attested': 'true', 'custom:production_bound': 'false',
    } } } } };
}
const cursor = (row: Record<string, unknown>, index: boolean) => Object.fromEntries(
  (index ? ['pk', 'sk', 'gsi1pk', 'gsi1sk'] : ['pk', 'sk']).map(key => [key, row[key]]));
describe('telehealth complete bounded lists', () => {
  beforeEach(() => send.mockReset());
  afterEach(() => vi.restoreAllMocks());
  for (const c of cases) {
    it(`${c.name}: reads past an empty page and never substitutes a partial first page`, async () => {
      const key = cursor(c.row(1), c.index);
      send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: key }).mockResolvedValueOnce({ Items: [c.row(2)] });
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(200); expect(JSON.parse(response.body).data).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(key);
      expect(send.mock.calls[0][0].input.ConsistentRead).toBe(c.index ? undefined : true);
      expect(response.body).not.toContain('fictional@example.test');
    });
    it(`${c.name}: refuses a later failure without leaking the earlier page`, async () => {
      const first = c.row(1);
      send.mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: cursor(first, c.index) }).mockRejectedValueOnce(new Error('fictional failure'));
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(503); expect(JSON.parse(response.body)).toEqual({ error: 'service_unavailable' });
    });
    it(`${c.name}: refuses repeated cursors and does not loop indefinitely`, async () => {
      send.mockResolvedValue({ Items: [], LastEvaluatedKey: cursor(c.row(1), c.index) });
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(503); expect(send).toHaveBeenCalledTimes(2);
    });
    it(`${c.name}: refuses an unfinished twentieth page`, async () => {
      let n = 0; send.mockImplementation(async () => ({ Items: [], LastEvaluatedKey: cursor(c.row(++n), c.index) }));
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(503); expect(send).toHaveBeenCalledTimes(20);
    });
    for (const malformed of [null, [], 'foreign', { pk: `ORG#${foreignOrg}`, sk: 'SLOT#foreign' }, { ...cursor(c.row(1), c.index), surprise: 'secret' }]) {
      it(`${c.name}: refuses malformed or wrongly bound continuation ${JSON.stringify(malformed)}`, async () => {
        send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: malformed });
        const response = await createTelehealthHandler(config)(event(c.route, c.body));
        expect(response.statusCode).toBe(503); expect(send).toHaveBeenCalledTimes(1);
      });
    }
    it(`${c.name}: refuses duplicate records across pages`, async () => {
      const row = c.row(1);
      send.mockResolvedValueOnce({ Items: [row], LastEvaluatedKey: cursor(row, c.index) }).mockResolvedValueOnce({ Items: [row] });
      expect((await createTelehealthHandler(config)(event(c.route, c.body))).statusCode).toBe(503);
    });
    it(`${c.name}: refuses records outside the query owner or clinic`, async () => {
      const row = { ...c.row(1), pk: `ORG#${foreignOrg}`, organizationId: foreignOrg, ...(c.index ? { consumerPersonId: id(9) } : {}) };
      send.mockResolvedValueOnce({ Items: [row] });
      expect((await createTelehealthHandler(config)(event(c.route, c.body))).statusCode).toBe(503);
    });
    it(`${c.name}: refuses invalid item collections`, async () => {
      send.mockResolvedValueOnce({ Items: { secret: 'not a list' } });
      expect((await createTelehealthHandler(config)(event(c.route, c.body))).statusCode).toBe(503);
    });
    it(`${c.name}: refuses a response beyond the requested page limit`, async () => {
      const limit = c.index ? 100 : c.row === slot ? 500 : 200;
      send.mockResolvedValueOnce({ Items: Array.from({ length: limit + 1 }, (_, n) => c.row(n + 1)) });
      expect((await createTelehealthHandler(config)(event(c.route, c.body))).statusCode).toBe(503);
    });
    it(`${c.name}: bounds the combined byte budget, not each page in isolation`, async () => {
      const first = { ...c.row(1), fictionalPadding: 'x'.repeat(1_600_000) };
      send.mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: cursor(first, c.index) })
        .mockResolvedValueOnce({ Items: [{ ...c.row(2), fictionalPadding: 'x'.repeat(1_600_000) }] });
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(503); expect(JSON.parse(response.body)).toEqual({ error: 'service_unavailable' });
    });
    it(`${c.name}: carries one abort signal across all pages and refuses a late reply`, async () => {
      const controller = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const first = c.row(1);
      send.mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: cursor(first, c.index) })
        .mockImplementationOnce(async () => { controller.abort(); return { Items: [c.row(2)] }; });
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(503);
      expect(send.mock.calls.map(call => call[1]?.abortSignal)).toEqual([controller.signal, controller.signal]);
    });
    it(`${c.name}: refuses duplicate logical identities at different storage keys`, async () => {
      const first = c.row(1), duplicate = { ...first, sk: `${c.row(2).sk}#${'slotId' in first ? first.slotId : first.requestId}` };
      send.mockResolvedValueOnce({ Items: [first], LastEvaluatedKey: cursor(first, c.index) }).mockResolvedValueOnce({ Items: [duplicate] });
      expect((await createTelehealthHandler(config)(event(c.route, c.body))).statusCode).toBe(503);
    });
    it(`${c.name}: permits a genuinely completed empty list`, async () => {
      send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: {} });
      const response = await createTelehealthHandler(config)(event(c.route, c.body));
      expect(response.statusCode).toBe(200); expect(JSON.parse(response.body).data).toEqual([]);
    });
  }
  it('consumer index may cross clinics for this owner, but only the requested clinic is projected', async () => {
    const other = appointment(1, foreignOrg);
    send.mockResolvedValueOnce({ Items: [other], LastEvaluatedKey: cursor(other, true) }).mockResolvedValueOnce({ Items: [appointment(2)] });
    const response = await createTelehealthHandler(config)(event(cases[2].route));
    expect(response.statusCode).toBe(200); expect(JSON.parse(response.body).data.map((r: { requestId: string }) => r.requestId)).toEqual([id(2)]);
  });
  it('slot publication checks later-page overlaps before any write', async () => {
    const existing = slot(1);
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor(slot(0), false) }).mockResolvedValueOnce({ Items: [existing] });
    const response = await createTelehealthHandler(config)(event('POST /clinical-core/workforce/appointments/slots', {
      start: existing.start, end: existing.end, timeZone: existing.timeZone, visitTypes: existing.visitTypes,
      priceMinor: 0, currency: 'USD', cancellationPolicy: existing.cancellationPolicy, cancellationWindowHours: 24,
    }));
    expect(response.statusCode).toBe(409); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([command]) => command.constructor.name === 'QueryCommand')).toBe(true);
  });
  it('can hold an eligible later-page slot without inventing a new slot', async () => {
    const target = slot(2), key = cursor(slot(1), false);
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: key }).mockResolvedValueOnce({ Items: [target] }).mockResolvedValueOnce({});
    const response = await createTelehealthHandler(config)(event('POST /clinical-core/consumer/appointments/holds', { slotId: target.slotId, visitType: 'follow_up' }));
    expect(response.statusCode).toBe(201); expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].input).toMatchObject({ Key: cursor(target, false),
      ConditionExpression: '#status=:available OR (#status=:held AND holdExpiresAt<=:now)',
      ExpressionAttributeValues: { ':person': person } });
  });
  it('cannot publish a slot while its bounded conflict lookup is unfinished', async () => {
    let n = 0; send.mockImplementation(async () => ({ Items: [], LastEvaluatedKey: cursor(slot(++n), false) }));
    const target = slot(1);
    const response = await createTelehealthHandler(config)(event('POST /clinical-core/workforce/appointments/slots', {
      start: target.start, end: target.end, timeZone: target.timeZone, visitTypes: target.visitTypes,
      priceMinor: 0, currency: 'USD', cancellationPolicy: target.cancellationPolicy, cancellationWindowHours: 24,
    }));
    expect(response.statusCode).toBe(503); expect(send).toHaveBeenCalledTimes(20);
    expect(send.mock.calls.every(([command]) => command.constructor.name === 'QueryCommand')).toBe(true);
  });
  it('cannot republish an overlapping opening over a booked slot', async () => {
    const existing = { ...slot(1), status: 'booked' };
    send.mockResolvedValueOnce({ Items: [existing] }).mockResolvedValueOnce({});
    const response = await createTelehealthHandler(config)(event('POST /clinical-core/workforce/appointments/slots', {
      start: existing.start, end: existing.end, timeZone: existing.timeZone, visitTypes: existing.visitTypes,
      priceMinor: 0, currency: 'USD', cancellationPolicy: existing.cancellationPolicy, cancellationWindowHours: 24,
    }));
    expect(response.statusCode).toBe(409); expect(send).toHaveBeenCalledTimes(1);
  });
});
