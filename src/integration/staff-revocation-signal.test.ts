import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { STAFF_REVOCATION_SIGNAL_CONTRACT as READER_CONTRACT, createDynamoStaffRevocationSignal } from '@/campaigns/staff-revocation';
import { fictionalEngine } from '@/campaigns/testing';
import { PENDING_TTL_MS, STAFF_REVOCATION_SIGNAL_CONTRACT as WRITER_CONTRACT, createDynamoStaffRevocationSignalPublisher } from '@/server/clinical-core/staff-revocation-signal';
import { fictionalSignalTable } from '@/test-support/fictional-signal-table';

/**
 * The staff revocation signal end to end: the emergency revocation's writer and the campaign API's reader share no
 * module, so this checks that they agree on the wire (table, key, item, the conditions each phase writes under),
 * through one fictional DynamoDB table that evaluates those exact conditions, and that what the writer publishes stops
 * the staff route. Fictional practice, person and subjects.
 */
const PRACTICE = '11111111-1111-4111-8111-111111111111';
const ADMIN = { practiceId: PRACTICE, personId: '21111111-1111-4111-8111-111111111111', subject: 'fictional-subject-21111111-1111-4111-8111-111111111111', email: 'admin@fictional-clinic.example', name: 'Fictional Admin' };
const SUBJECT = 'fictional-workforce-admin-0001';

describe('the staff revocation signal, writer to reader', () => {
  it('both sides name the same contract', () => {
    expect(WRITER_CONTRACT).toBe(READER_CONTRACT);
  });

  async function route(now = () => Date.now()) {
    const table = fictionalSignalTable();
    const e = fictionalEngine();
    await e.readyPractice({ practiceId: PRACTICE, slug: 'fictional-clinic', name: 'Fictional Clinic', domain: 'mail.fictional-clinic.example', admin: ADMIN });
    e.deps.staffRevocation = createDynamoStaffRevocationSignal({ client: table.client as never, tableName: table.tableName, now });
    const staff = async () => (await e.http({ routeKey: 'POST /campaigns/workforce', body: '{"action":"overview"}', requestContext: { authorizer: { jwt: { claims: {
      sub: SUBJECT, 'custom:organization_id': PRACTICE, 'custom:person_id': ADMIN.personId, email: ADMIN.email, exp: Date.now() / 1000 + 600 } } } } })).statusCode;
    const publisher = createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: table.tableName, now });
    return { table, staff, publisher };
  }

  it('what the emergency revocation publishes, the campaign staff route refuses; a second publication changes nothing', async () => {
    const { table, staff, publisher } = await route();
    expect(await staff()).toBe(200);
    const first = randomUUID();
    await publisher.publish(SUBJECT, first);
    expect(await staff()).toBe(403);
    await publisher.publish(SUBJECT, randomUUID());
    expect(table.items.get(SUBJECT)).toEqual({ subject: SUBJECT, revocationId: first, contract: WRITER_CONTRACT });
    expect(await staff()).toBe(403);
    // Nothing a reader holds is personal: a subject, the revocation's id and the contract.
    expect(JSON.stringify([...table.items.values()])).not.toMatch(/@|eyJ|Fictional/);
  });

  it('a pending decision refuses at once; released, the login is back; published over, it is revoked for good', async () => {
    const { table, staff, publisher } = await route();
    const decision = randomUUID();
    await publisher.hold(SUBJECT, decision);
    expect(await staff()).toBe(403);
    await publisher.release(SUBJECT, decision);
    expect(await staff()).toBe(200);
    await publisher.hold(SUBJECT, decision);
    const revocation = randomUUID();
    await publisher.publish(SUBJECT, revocation);
    expect(table.items.get(SUBJECT)).toEqual({ subject: SUBJECT, revocationId: revocation, contract: WRITER_CONTRACT });
    // Nothing undoes a revocation: not a late release of that decision, not a new pending one lapsing, and the
    // writer's role cannot delete the revocation item at all.
    await publisher.release(SUBJECT, decision);
    await publisher.hold(SUBJECT, randomUUID());
    expect(table.items.get(SUBJECT)).toEqual({ subject: SUBJECT, revocationId: revocation, contract: WRITER_CONTRACT });
    expect(await staff()).toBe(403);
    await expect(table.client.send({ constructor: { name: 'DeleteCommand' }, input: { TableName: table.tableName, Key: { subject: SUBJECT } } } as never))
      .rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('a release names its own decision: another decision\'s pending item stays', async () => {
    const { staff, publisher } = await route();
    await publisher.hold(SUBJECT, randomUUID());
    await publisher.release(SUBJECT, randomUUID());
    expect(await staff()).toBe(403);
  });

  it('a pending item nobody released lapses at its own deadline: a failed decision never revokes a login for good', async () => {
    let clock = Date.now();
    const { staff, publisher } = await route(() => clock);
    await publisher.hold(SUBJECT, randomUUID());
    clock += PENDING_TTL_MS - 1;
    expect(await staff()).toBe(403);
    clock += 2;
    expect(await staff()).toBe(200);
  });

  it('an item written under /1 is a revocation, and is never replaced', async () => {
    const { table, staff, publisher } = await route();
    table.items.set(SUBJECT, { subject: SUBJECT, revocationId: randomUUID(), contract: 'staff-revocation-signal/1' });
    const before = { ...table.items.get(SUBJECT) };
    await publisher.hold(SUBJECT, randomUUID());
    await publisher.publish(SUBJECT, randomUUID());
    expect(table.items.get(SUBJECT)).toEqual(before);
    expect(await staff()).toBe(403);
  });
});
