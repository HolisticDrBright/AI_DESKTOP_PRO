import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ApiGatewayV2Event } from './aws-identity-api';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));
vi.mock('@aws-sdk/lib-dynamodb', () => ({ DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: class GetCommand { constructor(readonly input: Record<string, unknown>) {} },
  QueryCommand: class QueryCommand { constructor(readonly input: Record<string, unknown>) {} },
  PutCommand: class PutCommand { constructor(readonly input: Record<string, unknown>) {} },
  TransactWriteCommand: class TransactWriteCommand { constructor(readonly input: Record<string, unknown>) {} },
  UpdateCommand: class {}, TransactGetCommand: class {},
}));
import { createTelehealthHandler, type TelehealthConfiguration } from './aws-telehealth-requests';
const org = '22222222-2222-4222-8222-222222222222', other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = Date.parse('2026-10-11T19:00:00.000Z');
const config: TelehealthConfiguration = { tableName: 'fictional-slots', consumerIssuer: 'https://fictional-consumer.test', consumerAudience: 'consumer',
  workforceIssuer: 'https://fictional-workforce.test', workforceAudience: 'workforce', runtimeMode: 'synthetic', phiAllowed: false,
  zoomEnabled: false, zoomBaaVerified: false, zoomSecretArn: '', remindersEnabled: false, reminderSender: '', reminderConfigurationSet: '',
  reminderScheduleGroup: '', reminderSchedulerRoleArn: '', reminderTargetArn: '', reminderEventsTopicArn: '', stripeTestEnabled: false,
  stripeSecretArn: '', stripeSuccessUrl: '', stripeCancelUrl: '', identityApiOrigin: 'https://fictional-api.test', chartAdmissionSecretArn: '' };
const guardKey = (organizationId = org) => ({ pk: `ORG#${organizationId}`, sk: 'SLOT_PUBLICATION#1' });
const guard = (revision = 1, organizationId = org) => ({ ...guardKey(organizationId), protocol: 'slot-publication/1', organizationId, revision });
const input = (offset = 0) => ({ start: new Date(now + 86_400_000 + offset).toISOString(), end: new Date(now + 88_200_000 + offset).toISOString(),
  timeZone: 'America/Los_Angeles', visitTypes: ['follow_up'], priceMinor: 0, currency: 'USD', cancellationPolicy: 'Fictional policy only.', cancellationWindowHours: 24 });
function event(value = input(), organizationId = org): ApiGatewayV2Event {
  return { routeKey: 'POST /clinical-core/workforce/appointments/slots', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    requestContext: { authorizer: { jwt: { claims: { iss: config.workforceIssuer, aud: config.workforceAudience, token_use: 'id',
      sub: 'fictional-workforce', 'custom:person_id': '11111111-1111-4111-8111-111111111111', 'custom:organization_id': organizationId,
      'custom:synthetic_attested': 'true', 'custom:production_bound': 'false' } } } } };
}
type Row = Record<string, unknown>;
type Put = { TableName: string; Item: Row; ConditionExpression?: string; ExpressionAttributeNames?: Row; ExpressionAttributeValues?: Row };
/** Fictional conditional store: evaluates every condition before publishing
 * any row. No mocked response can stand in for real AWS qualification. */
class Store {
  rows = new Map<string, Row>();
  queryCount = 0;
  queryBarrier?: Promise<void>;
  unblock?: () => void;
  afterQuery?: () => void;
  transactionFailure?: 'before' | 'after';
  key(row: Row) { return `${row.pk}|${row.sk}`; }
  slots() { return [...this.rows.values()].filter(row => String(row.sk).startsWith('SLOT#')); }
  race() { this.queryBarrier = new Promise(resolve => { this.unblock = resolve; }); }
  async read(command: { input: Row }, options?: { abortSignal?: AbortSignal }) {
    if (options?.abortSignal?.aborted) throw new Error('fictional timeout');
    const value = command.input;
    if (value.Key) {
      const row = this.rows.get(this.key(value.Key as Row)); return row ? { Item: structuredClone(row) } : {};
    }
    if (value.KeyConditionExpression) {
      const organizationKey = (value.ExpressionAttributeValues as Row)[':org'];
      const snapshot = this.slots().filter(row => row.pk === organizationKey).map(row => structuredClone(row));
      this.queryCount++; if (this.queryCount === 2) this.unblock?.();
      if (this.queryBarrier) await this.queryBarrier;
      this.afterQuery?.(); return { Items: snapshot };
    }
    const puts = value.TransactItems ? (value.TransactItems as { Put: Put }[]).map(row => row.Put) : [value as Put];
    if (this.transactionFailure === 'before') throw new Error('fictional transaction unavailable');
    for (const put of puts) {
      const row = this.rows.get(this.key(put.Item)), expected = put.ExpressionAttributeValues?.[':expected'];
      let matches: boolean;
      if (put.ConditionExpression === undefined) matches = true;
      else if (put.ConditionExpression === 'attribute_not_exists(pk) AND attribute_not_exists(sk)') matches = !row;
      else if (put.ConditionExpression === '#revision=:expected AND #protocol=:protocol AND organizationId=:org'
        && put.ExpressionAttributeNames?.['#revision'] === 'revision' && put.ExpressionAttributeNames?.['#protocol'] === 'protocol')
        matches = row?.revision === expected && row?.protocol === put.ExpressionAttributeValues?.[':protocol'] && row?.organizationId === put.ExpressionAttributeValues?.[':org'];
      else throw new Error('fictional store received an unsupported condition');
      if (!matches) throw Object.assign(new Error('fictional condition refused'), { name: 'TransactionCanceledException',
        CancellationReasons: puts.map(candidate => ({ Code: candidate === put ? 'ConditionalCheckFailed' : 'None' })) });
    }
    for (const put of puts) this.rows.set(this.key(put.Item), structuredClone(put.Item));
    if (this.transactionFailure === 'after') throw new Error('fictional lost receipt');
    return {};
  }
}
let store: Store;
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); send.mockReset(); store = new Store(); send.mockImplementation(store.read.bind(store)); });
afterEach(() => vi.restoreAllMocks());
it('two simultaneous overlapping publications cannot both succeed after observing the same empty calendar', async () => {
  store.race(); const handler = createTelehealthHandler(config);
  const answers = await Promise.all([handler(event()), handler(event(input(60_000)))]);
  expect(answers.map(answer => answer.statusCode).sort()).toEqual([201, 409]);
  expect(store.slots()).toHaveLength(1); expect(store.rows.get(store.key(guardKey()))).toEqual(guard());
});
it('sequential overlapping publication refuses without a second transaction or replacement', async () => {
  const handler = createTelehealthHandler(config); expect((await handler(event())).statusCode).toBe(201);
  expect((await handler(event(input(60_000)))).statusCode).toBe(409); expect(store.slots()).toHaveLength(1);
  expect(send.mock.calls.filter(([command]) => command.input.TransactItems)).toHaveLength(1);
});
it('adjacent openings remain publishable and advance the clinic guard in the same transactions', async () => {
  const handler = createTelehealthHandler(config); expect((await handler(event())).statusCode).toBe(201);
  expect((await handler(event(input(1_800_000)))).statusCode).toBe(201);
  expect(store.slots()).toHaveLength(2); expect(store.rows.get(store.key(guardKey()))).toEqual(guard(2));
  const second = send.mock.calls.filter(([command]) => command.input.TransactItems)[1][0].input.TransactItems[0].Put;
  expect(second).toMatchObject({ ConditionExpression: '#revision=:expected AND #protocol=:protocol AND organizationId=:org',
    ExpressionAttributeNames: { '#revision': 'revision', '#protocol': 'protocol' },
    ExpressionAttributeValues: { ':expected': 1, ':protocol': 'slot-publication/1', ':org': org } });
});
it('the fictional store does not invent a condition for an unconditional put', async () => {
  await store.read({ input: { TableName: config.tableName, Item: guard() } });
  await store.read({ input: { TableName: config.tableName, Item: guard(2) } });
  expect(store.rows.get(store.key(guardKey()))).toEqual(guard(2));
});
it('clinics have independent guard keys and cannot replace one another', async () => {
  const handler = createTelehealthHandler(config); expect((await handler(event())).statusCode).toBe(201);
  expect((await handler(event(input(), other))).statusCode).toBe(201);
  expect(store.rows.get(store.key(guardKey(other)))).toEqual(guard(1, other)); expect(store.slots()).toHaveLength(2);
});
it.each([{ revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: '1' }, { revision: Number.MAX_SAFE_INTEGER },
  { protocol: 'foreign/1' }, { organizationId: other }, { pk: `ORG#${other}` }, { sk: 'SLOT_PUBLICATION#foreign' }])('refuses a malformed or wrongly bound guard %j before any publication', async change => {
  store.rows.set(store.key(guardKey()), { ...guard(), ...change }); const answer = await createTelehealthHandler(config)(event());
  expect(answer.statusCode).toBe(503); expect(store.queryCount).toBe(0); expect(store.slots()).toHaveLength(0);
});
it('a guard read failure refuses without a calendar read or write', async () => {
  send.mockRejectedValueOnce(new Error('fictional read failed')); expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503);
  expect(send).toHaveBeenCalledOnce(); expect(store.slots()).toHaveLength(0);
});
it.each([{ start: undefined }, { end: undefined }, { start: 'not-a-date' }, { end: 'not-a-date' },
  { end: input().start }])('an unreadable existing interval cannot be ignored as free time %j', async change => {
  const saved = { ...input(), ...change, ...guardKey(), sk: 'SLOT#legacy', organizationId: org,
    slotId: '33333333-3333-4333-8333-333333333333' };
  store.rows.set(store.key(saved), saved);
  expect((await createTelehealthHandler(config)(event(input(7_200_000)))).statusCode).toBe(503);
  expect(send.mock.calls.some(([command]) => command.input.TransactItems)).toBe(false);
});
it('a publication between the guard read and the last query page makes the final write refuse', async () => {
  store.afterQuery = () => store.rows.set(store.key(guardKey()), guard());
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(409); expect(store.slots()).toHaveLength(0);
});
it('transaction failure before commitment writes neither a slot nor a guard', async () => {
  store.transactionFailure = 'before'; expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503);
  expect(store.rows.size).toBe(0);
});
it('a lost receipt does not claim success or roll back committed state, and a repeated request cannot create a duplicate', async () => {
  store.transactionFailure = 'after'; const handler = createTelehealthHandler(config);
  expect((await handler(event())).statusCode).toBe(503); expect(store.slots()).toHaveLength(1); expect(store.rows.get(store.key(guardKey()))).toEqual(guard());
  store.transactionFailure = undefined; expect((await handler(event())).statusCode).toBe(409); expect(store.slots()).toHaveLength(1);
});
it('never publishes a start which became past during the conflict read', async () => {
  store.afterQuery = () => vi.mocked(Date.now).mockReturnValue(now + 2 * 86_400_000);
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(400); expect(store.rows.size).toBe(0);
});
it('uses exact-table conditional puts, a strong guard read, bounded requests and a stable SDK transaction token', async () => {
  const answer = await createTelehealthHandler(config)(event()); expect(answer.statusCode).toBe(201);
  const first = send.mock.calls[0]; expect(first[0].input).toMatchObject({ TableName: config.tableName, Key: guardKey(), ConsistentRead: true });
  expect(first[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  const written = send.mock.calls.find(([command]) => command.input.TransactItems)!;
  expect(written[0].input.TransactItems).toHaveLength(2);
  expect(written[0].input.ClientRequestToken).toBe(JSON.parse(answer.body).data.slotId);
  expect(written[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  for (const row of written[0].input.TransactItems) expect(row.Put).toMatchObject({ TableName: config.tableName,
    ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)' });
});
it('unclassified transaction cancellation remains unavailable, never an asserted non-commitment or overlap', async () => {
  send.mockImplementation(async (command, options) => {
    if (command.input.TransactItems) throw Object.assign(new Error('fictional capacity'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }] });
    return store.read(command, options);
  });
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503); expect(store.rows.size).toBe(0);
});
it('a late write reply after its deadline does not certify success or erase committed rows', async () => {
  const read = new AbortController(), list = new AbortController(), write = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(read.signal).mockReturnValueOnce(list.signal).mockReturnValueOnce(write.signal);
  send.mockImplementation(async (command, options) => {
    const result = await store.read(command, options); if (command.input.TransactItems) write.abort(); return result;
  });
  expect((await createTelehealthHandler(config)(event())).statusCode).toBe(503);
  expect(store.slots()).toHaveLength(1); expect(store.rows.get(store.key(guardKey()))).toEqual(guard());
});
it('production remains refused with PHI disabled', async () => {
  expect((await createTelehealthHandler({ ...config, runtimeMode: 'production' })(event())).statusCode).toBe(503); expect(send).not.toHaveBeenCalled();
});
it('template identity declares the atomic publication protocol without widening table permissions', () => {
  const template = JSON.parse(readFileSync('infra/aws-clinical-core/telehealth-requests-extension.json', 'utf8'));
  expect(template.Metadata.ClinicalCore).toMatchObject({ ContractVersion: 'telehealth-requests/10', SlotPublicationContract: 'slot-publication/1', PhiAllowed: false });
  expect(template.Outputs.ContractVersion.Value).toBe('telehealth-requests/10');
});
