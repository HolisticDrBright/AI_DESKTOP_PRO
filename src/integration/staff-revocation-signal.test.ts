import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { STAFF_REVOCATION_SIGNAL_CONTRACT as READER_CONTRACT, createDynamoStaffRevocationSignal } from '@/campaigns/staff-revocation';
import { fictionalEngine } from '@/campaigns/testing';
import { STAFF_REVOCATION_SIGNAL_CONTRACT as WRITER_CONTRACT, createDynamoStaffRevocationSignalPublisher } from '@/server/clinical-core/staff-revocation-signal';

/**
 * The staff revocation signal end to end: the emergency revocation's writer and the campaign API's reader share no
 * module, so this checks that they agree on the wire (table, key, item, never-overwrite), through one fictional
 * DynamoDB table, and that what the writer publishes stops the staff route. Fictional practice, person and subjects.
 */
const TABLE = 'alp-campaign-staff-revocations';
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const SUBJECT = 'fictional-workforce-admin-0001';

/** One fictional DynamoDB table, as the document client sees it: Put with attribute_not_exists, and Get. */
function fictionalTable() {
  const items = new Map<string, Record<string, unknown>>();
  type Input = { TableName?: string; Key: { subject: string }; Item: { subject: string } & Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: unknown };
  const send = async (command: { constructor: { name: string }; input: Input }) => {
    const { TableName, Key, Item, ConditionExpression, ExpressionAttributeNames } = command.input;
    if (TableName !== TABLE) throw Object.assign(new Error('no such table'), { name: 'ResourceNotFoundException' });
    if (command.constructor.name === 'PutCommand') {
      expect(ConditionExpression).toBe('attribute_not_exists(#s)');
      expect(ExpressionAttributeNames).toEqual({ '#s': 'subject' });
      if (items.has(Item.subject)) throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      items.set(Item.subject, { ...Item });
      return {};
    }
    if (command.constructor.name === 'GetCommand') {
      expect(Object.keys(Key)).toEqual(['subject']);
      const item = items.get(Key.subject);
      return item ? { Item: { subject: item.subject } } : {};
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  };
  return { items, client: { send } };
}

describe('the staff revocation signal, writer to reader', () => {
  it('both sides name the same contract', () => {
    expect(WRITER_CONTRACT).toBe(READER_CONTRACT);
  });

  it('what the emergency revocation publishes, the campaign staff route refuses; a second publication changes nothing', async () => {
    const table = fictionalTable();
    const e = fictionalEngine();
    await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    e.deps.staffRevocation = createDynamoStaffRevocationSignal({ client: table.client as never, tableName: TABLE });
    const staff = () => e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: { authorizer: { jwt: { claims: {
      sub: SUBJECT, 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, email: ADMIN.email, exp: Date.now() / 1000 + 600 } } } } });
    expect((await staff()).statusCode).toBe(200);

    const publisher = createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: TABLE });
    const first = randomUUID();
    await publisher.publish(SUBJECT, first);
    const refused = await staff();
    expect([refused.statusCode, JSON.parse(refused.body)]).toEqual([403, { error: 'forbidden', detail: 'identity_refused' }]);

    await publisher.publish(SUBJECT, randomUUID());
    expect(table.items.get(SUBJECT)).toEqual({ subject: SUBJECT, revocationId: first, contract: WRITER_CONTRACT });
    expect((await staff()).statusCode).toBe(403);
    // Nothing a reader holds is personal: a subject, the revocation's id and the contract.
    expect(JSON.stringify([...table.items.values()])).not.toMatch(/@|eyJ|Fictional/);
  });
});
