import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deleteCoveredEntityContent, inspectCoveredEntityContent, parseCoveredEntityCoverage, deletionOrder } from './covered-entity-deletion';
import { createProductionCareMessaging, createProductionCareMessageExport } from './production-care-messaging';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import type { CareMessageRequest } from '../../contracts/careMessages';
import { createCareMessagingHandler, bindCareMessagingDatabase, type CareMessagingBuild } from './care-messaging-deployment';
import type { ApiGatewayV2Event } from './aws-identity-api';

// Real canonical production SQL; unreleased API, fictional rows only.
// This is not AWS, concurrency-load, activation or retention-policy evidence.
let db: PGlite;
let org: string, otherOrg: string, owner: string, other: string, staff: string, stranger: string;
let patient: string, connection: string, artifact: string;
let messagingBuild: CareMessagingBuild;
const subject = (person: string) => 'subject-' + person;
const context = (person = owner, pool: 'consumer' | 'workforce' = 'consumer', organization = org): ProductionClinicalRequestContext => ({
  actorPersonId: person, organizationId: organization, identitySubject: subject(person), identityPool: pool,
  environment: 'production-clinical', dataClassification: 'clinical_phi', purpose: 'clinical_data',
  productionBound: true, containsPhi: true, realPatientData: true,
});
const database: ClinicalCoreDatabase = { transaction: async work => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return work({ query: async (sql: string, args: unknown[] = []) => {
    try { return await tx.query(sql, args.map(v => typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)); }
    catch (e) {
      const message = e instanceof Error ? e.message : '';
      if (/care_message_(conflict|settled)/.test(message)) throw new ClinicalCoreDatabaseRejection('conflict');
      if (/care_message_consent_required/.test(message)) throw new ClinicalCoreDatabaseRejection('consent_required');
      if (/owned_account_deletion_write_blocked/.test(message)) throw new ClinicalCoreDatabaseRejection('account_deletion_write_blocked');
      if (/care_message_invalid/.test(message)) throw new ClinicalCoreDatabaseRejection('request_invalid');
      if (/(care_message_refused|request_context_refused|consumer_owner_required)/.test(message)) throw new ClinicalCoreDatabaseRejection('identity_refused');
      throw e;
    }
  } } as unknown as ClinicalCoreTransaction);
}) };
const call = (request: CareMessageRequest, who = context()) => createProductionCareMessaging(database)(who, request);
const send = (requestId = randomUUID(), link = connection) => ({ action: 'send' as const, requestId, connectionId: link,
  subject: 'Fictional question', body: 'FICTIONAL patient message', acknowledgement: 'care-messages/1' as const });
const withdraw = () => db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
  representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'messaging','revoked','patient_app','self','patient_request',2,$4)`, [org, patient, connection, owner]);
async function replacement() {
  await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [connection]);
  const next = randomUUID();
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [next, org, patient, owner]);
  await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
    representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [org, patient, next, artifact, owner]);
  return next;
}
beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
  const sql: string = files['20261006010000_production_care_messaging.sql'];
  messagingBuild = { sourceCommit: '1'.repeat(40), sourceClean: true, migrationCount: 105,
    migrationReleaseSha256: '7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743',
    functions: [...sql.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, schema, name, body]) => ({ schema, name, sha256: createHash('sha256').update(body).digest('hex'), callable: schema === 'clinical_core' })) };
  db = new PGlite({ extensions: { pgcrypto } });
  for (const m of manifest.migrations) await db.exec(files[m.file]);
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [org, otherOrg, owner, other, staff, stranger, patient, connection, artifact] = Array.from({ length: 9 }, () => randomUUID());
  for (const id of [org, otherOrg]) await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [id]);
  for (const [id, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce'], [stranger, 'workforce']]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id)]);
  }
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, staff]);
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Test')", [patient, org, 'patient_test_' + patient.replaceAll('-', '')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'messaging','fictional-local-test',$3,'TEST','approved',now(),$4)`, [artifact, org, 'a'.repeat(64), staff]);
  await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
    representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [org, patient, connection, artifact, owner]);
});

describe('unreleased production messaging over canonical inbox', () => {
  it('runs the deployment handler through the real API role, database contract and retained owner export', async () => {
    const now = Date.now(), review = '2'.repeat(64);
    const config = { SOURCE_COMMIT: messagingBuild.sourceCommit, MIGRATION_RELEASE_SHA256: messagingBuild.migrationReleaseSha256,
      AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked',
      CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
      WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
      CARE_MESSAGING_ORGANIZATION_ID: org, CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
      CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
      DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
      QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
      QUALIFICATION_IDENTITY_SUBJECTS: [owner, other, staff].map(subject).join(',') };
    const handler = createCareMessagingHandler(config, messagingBuild, () => database, () => now);
    const request = (body: unknown, who = owner, pool: 'consumer' | 'workforce' = 'consumer', privacy = false): ApiGatewayV2Event => ({
      routeKey: `POST /clinical-core/${pool}/messages${privacy ? '/export' : ''}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      requestContext: { authorizer: { jwt: { claims: { iss: config[pool === 'consumer' ? 'CONSUMER_ISSUER' : 'WORKFORCE_ISSUER'],
        aud: config[pool === 'consumer' ? 'CONSUMER_AUDIENCE' : 'WORKFORCE_AUDIENCE'], sub: subject(who),
        'custom:person_id': who, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
        iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } },
    });
    const sent = await handler(request(send())); expect(sent).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    const result = JSON.parse(sent.body).data;
    expect(await handler(request({ action: 'read', threadId: result.threadId }, other))).toMatchObject({ statusCode: 403 });
    expect(await handler(request({ action: 'read', threadId: result.threadId }, staff, 'workforce'))).toMatchObject({ statusCode: 200 });
    await withdraw();
    expect(await handler(request({ action: 'read', threadId: result.threadId }))).toMatchObject({ statusCode: 403 });
    const exported = await handler(request({ action: 'export', section: 'messages' }, owner, 'consumer', true));
    expect(exported.statusCode).toBe(200); expect(JSON.parse(exported.body).data.records).toHaveLength(1);
    expect(JSON.parse(exported.body).data.records[0].body).toBe('FICTIONAL patient message');
  });
  it('checks actual function search path, force-RLS, privileges and immutable trigger drift as the API role', async () => {
    const guarded = bindCareMessagingDatabase(database, messagingBuild);
    const check = () => guarded.transaction(async () => true);
    expect(await check()).toBe(true);
    const mutations = [
      ["alter function clinical_private.production_care_message_actor() set search_path=public", "alter function clinical_private.production_care_message_actor() set search_path=''"],
      ['alter table clinical_core.care_message_receipts no force row level security', 'alter table clinical_core.care_message_receipts force row level security'],
      ['grant select on clinical_core.care_message_receipts to public', 'revoke select on clinical_core.care_message_receipts from public'],
      ['alter table clinical_core.messages disable trigger stored_care_messages_immutable', 'alter table clinical_core.messages enable trigger stored_care_messages_immutable'],
    ];
    for (const [change, restore] of mutations) {
      await db.exec(change);
      try { await expect(check()).rejects.toThrow('service_unavailable'); }
      finally { await db.exec(restore); }
      expect(await check()).toBe(true);
    }
  });
  it('maps retained messaging to its clinic and detects a held app owner without staff membership', async () => {
    const sent = await call(send());
    if (sent.action !== 'send') throw new Error('wrong response');
    const coverage = parseCoveredEntityCoverage(JSON.parse(readFileSync('infra/aws-clinical-core/covered-entity-coverage.json', 'utf8')));
    const order = deletionOrder(coverage);
    expect(order.indexOf('clinical_core.care_message_receipts')).toBeLessThan(order.indexOf('clinical_core.messages'));
    expect(order.indexOf('clinical_core.care_message_thread_links')).toBeLessThan(order.indexOf('clinical_core.conversations'));
    const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => work({ query: (sql, args = []) =>
      tx.query(sql, args.map(v => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v)) } as ClinicalCoreTransaction)) };
    const inspect = (organizationId = org) => inspectCoveredEntityContent({ database: admin, organizationId, coverage });
    expect((await inspect()).rows).toContainEqual({ table: 'clinical_core.care_message_receipts', rows: 1 });
    expect((await inspect(otherOrg)).holds).toBe(false);
    let purged = false;
    await expect(deleteCoveredEntityContent({ database: admin, organizationId: org, coverage,
      termination: { confirmed: true, terminationReference: 'fictional-review' },
      objects: { purge: async () => { purged = true; return { purged: 0, absent: 0, failed: 0 }; } },
    })).rejects.toThrow('disposition_review_required');
    expect(purged).toBe(false);
    expect((await inspect()).rows).toContainEqual({ table: 'clinical_core.care_message_receipts', rows: 1 });
    await db.query("insert into clinical_private.owned_legal_holds(owner_id,reason_code,placed_by) values($1,'owner_dispute',$2)", [owner, staff]);
    expect((await inspect()).holds).toBe(true);
    await expect(deleteCoveredEntityContent({ database: admin, organizationId: org, coverage,
      termination: { confirmed: true, terminationReference: 'fictional-review' } })).rejects.toThrow('legal_hold_present');
    // A reassigned connection must not hide the original correspondence owner's hold.
    await db.query('update clinical_core.patient_connections set consumer_person_id=$1 where id=$2', [other, connection]);
    expect((await inspect()).holds).toBe(true); expect((await inspect(otherOrg)).holds).toBe(false);
    expect((await db.query('select body from clinical_core.messages where id=$1', [sent.messageId])).rows[0]).toEqual({ body: 'FICTIONAL patient message' });
  });
  it('stores one patient message in the real inbox and allows a clinician reply', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    expect(result).toMatchObject({ status: 'stored', duplicate: false });
    const reply = await call({ action: 'send', requestId: randomUUID(), connectionId: connection, threadId: result.threadId, body: 'FICTIONAL clinician reply', acknowledgement: 'care-messages/1' }, context(staff, 'workforce'));
    expect(reply).toMatchObject({ status: 'stored' });
    const read = await call({ action: 'read', threadId: result.threadId });
    expect(read).toMatchObject({ messages: [{ sender: 'workforce', body: 'FICTIONAL clinician reply' }, { sender: 'consumer', body: 'FICTIONAL patient message' }] });
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.messages where conversation_id=$1', [result.threadId])).rows[0].n).toBe(2);
    expect(await call({ action: 'list' }, context(staff, 'workforce'))).toMatchObject({ threads: [{ threadId: result.threadId }] });
  });
  it('refuses cross-owner, cross-organization, unassigned workforce and substituted identity', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    for (const c of [context(other), context(owner, 'consumer', otherOrg), context(stranger, 'workforce'), { ...context(), identitySubject: 'wrong-subject' }]) {
      await expect(call({ action: 'read', threadId: result.threadId }, c)).rejects.toThrow('identity_refused');
    }
    expect(await call({ action: 'list' }, context(other))).toMatchObject({ threads: [] });
    await expect(call(send(), context(other))).rejects.toThrow('identity_refused');
  });
  it('requires current signed messaging consent for both patient and practitioner', async () => {
    await withdraw();
    await expect(call(send())).rejects.toThrow('consent_required');
    await expect(call(send(), context(staff, 'workforce'))).rejects.toThrow('consent_required');
    expect(await call({ action: 'list' })).toMatchObject({ threads: [] });
  });
  it('refuses draft, retired and future-dated consent artifacts', async () => {
    await db.query("update clinical_core.consent_artifacts set status='retired' where id=$1", [artifact]);
    await expect(call(send())).rejects.toThrow('consent_required');
    await db.query("update clinical_core.consent_artifacts set status='approved',approved_at=now()+interval '1 day' where id=$1", [artifact]);
    await expect(call(send())).rejects.toThrow('consent_required');
  });
  it('does not expose private practitioner drafts through patient reads', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    await db.query("insert into clinical_core.messages(organization_id,conversation_id,sender_person_id,body) values($1,$2,$3,'PRIVATE DRAFT')", [org, result.threadId, staff]);
    expect(JSON.stringify(await call({ action: 'read', threadId: result.threadId }))).not.toContain('PRIVATE DRAFT');
  });
  it('replays an identical send but rejects a changed request and writes one receipt', async () => {
    const request = send();
    const first = await call(request);
    expect(await call(request)).toMatchObject({ ...first, duplicate: true });
    await expect(call({ ...request, body: 'Different' })).rejects.toThrow('conflict');
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.care_message_receipts where sender_id=$1', [owner])).rows[0].n).toBe(1);
  });
  it('send-first settlement commits and never makes a cancellation tombstone', async () => {
    const request = send();
    const sent = await call(request);
    expect(await call({ action: 'settle', requestId: request.requestId, connectionId: connection })).toMatchObject({ status: 'committed' });
    expect(await call({ action: 'receipt', requestId: request.requestId, connectionId: connection })).toMatchObject({ status: 'committed' });
    expect(sent).toMatchObject({ status: 'stored' });
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.care_message_cancellations where sender_id=$1', [owner])).rows[0].n).toBe(0);
  });
  it('settle-first is durable across repeat settlement, another service instance and late send', async () => {
    const request = send();
    const settle = { action: 'settle' as const, requestId: request.requestId, connectionId: connection };
    expect(await call(settle)).toMatchObject({ status: 'cancelled' });
    expect(await call(settle)).toMatchObject({ status: 'cancelled' });
    await expect(call(request)).rejects.toThrow('conflict');
    expect(await createProductionCareMessaging(database)(context(), { ...settle, action: 'receipt' })).toMatchObject({ status: 'cancelled' });
  });
  it('withholds identifiers after consent withdrawal instead of pretending a delivered message was cancelled', async () => {
    const request = send();
    await call(request); await withdraw();
    const settled = await call({ action: 'settle', requestId: request.requestId, connectionId: connection });
    expect(settled).toEqual({ action: 'settle', requestId: request.requestId, connectionId: connection, status: 'withheld' });
    await expect(call({ action: 'receipt', requestId: request.requestId, connectionId: connection })).rejects.toThrow();
  });
  it('checks receipts across replaced links, and a second device converges on cancelled', async () => {
    const delivered = send(), cancelled = send();
    await call(delivered);
    await call({ action: 'settle', requestId: cancelled.requestId, connectionId: connection });
    const next = await replacement();
    expect(await call({ action: 'settle', requestId: delivered.requestId, connectionId: next })).toEqual({ action: 'settle', requestId: delivered.requestId, connectionId: next, status: 'withheld' });
    expect(await call({ action: 'receipt', requestId: cancelled.requestId, connectionId: next })).toMatchObject({ status: 'cancelled' });
    await expect(call({ ...cancelled, connectionId: next })).rejects.toThrow('conflict');
  });
  it('denies direct API table reads/writes and makes admitted bodies immutable', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    for (const table of ['care_message_thread_links', 'care_message_receipts', 'care_message_cancellations']) {
      await expect(database.transaction(tx => tx.query('select * from clinical_core.' + table))).rejects.toThrow();
      const flags = await db.query<{ enabled: boolean; forced: boolean }>('select relrowsecurity enabled,relforcerowsecurity forced from pg_class where oid=$1::regclass', ['clinical_core.' + table]);
      expect(flags.rows[0]).toEqual({ enabled: true, forced: true });
    }
    await expect(db.query("update clinical_core.messages set body='CHANGED' where id=$1", [result.messageId])).rejects.toThrow('append_only_record');
    await expect(db.query('delete from clinical_core.messages where id=$1', [result.messageId])).rejects.toThrow('append_only_record');
  });
  it('rejects invalid and synthetic contexts before the production query', async () => {
    await expect(createProductionCareMessaging(database)({ ...context(), productionBound: false } as never, send())).rejects.toThrow('identity_refused');
    await expect(createProductionCareMessaging(database)({ ...context(), purpose: 'consent_management' }, send())).rejects.toThrow('identity_refused');
    await expect(createProductionCareMessaging(database)(context(), { ...send(), extra: true })).rejects.toThrow('request_invalid');
    await expect(call({ action: 'settle', requestId: randomUUID(), connectionId: connection }, context(staff, 'workforce'))).rejects.toThrow('identity_refused');
  });
  it('exports retained correspondence after withdrawal and replacement but never practitioner drafts', async () => {
    const request = send(), result = await call(request);
    if (result.action !== 'send') throw new Error('wrong response');
    await call({ action: 'send', requestId: randomUUID(), connectionId: connection, threadId: result.threadId,
      body: 'FICTIONAL reply', acknowledgement: 'care-messages/1' }, context(staff, 'workforce'));
    await db.query("insert into clinical_core.messages(organization_id,conversation_id,sender_person_id,body) values($1,$2,$3,'PRIVATE DRAFT')", [org, result.threadId, staff]);
    const cancelled = randomUUID();
    await call({ action: 'settle', requestId: cancelled, connectionId: connection });
    await withdraw(); await replacement();
    const privacy = { ...context(), purpose: 'consent_management' as const };
    const exportMessages = createProductionCareMessageExport(database);
    const messages = await exportMessages(privacy, { action: 'export', section: 'messages' });
    expect(messages.records).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toMatch(/PRIVATE DRAFT|command_sha256|identity_subject/);
    expect(await exportMessages(privacy, { action: 'export', section: 'settlements' })).toMatchObject({ records: [{ requestId: cancelled, status: 'cancelled' }] });
    expect(await exportMessages(privacy, { action: 'export', section: 'threads' })).toMatchObject({ records: [{ threadId: result.threadId }] });
    expect(await exportMessages({ ...context(other), purpose: 'consent_management' }, { action: 'export', section: 'messages' })).toMatchObject({ records: [] });
    await expect(exportMessages(context(), { action: 'export', section: 'messages' })).rejects.toThrow('identity_refused');
    await expect(exportMessages({ ...context(staff, 'workforce'), purpose: 'consent_management' }, { action: 'export', section: 'messages' })).rejects.toThrow('identity_refused');
  });
  it('pins the original owner and prevents connection reassignment exposing past correspondence', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    await db.query('update clinical_core.patient_connections set consumer_person_id=$1 where id=$2', [other, connection]);
    await expect(call({ action: 'read', threadId: result.threadId }, context(other))).rejects.toThrow('identity_refused');
    expect(await call({ action: 'list' }, context(other))).toMatchObject({ threads: [] });
    const exporter = createProductionCareMessageExport(database);
    expect(await exporter({ ...context(other), purpose: 'consent_management' }, { action: 'export', section: 'messages' })).toMatchObject({ records: [] });
    expect(await exporter({ ...context(), purpose: 'consent_management' }, { action: 'export', section: 'messages' })).toMatchObject({ records: [{ messageId: result.messageId }] });
  });
  it('fences new patient sends during account deletion but permits historical receipts and privacy copies', async () => {
    const request = send(); await call(request);
    await db.query("insert into clinical_private.owned_privacy_requests(owner_id,request_id,kind,status) values($1,$2,'deletion','submitted')", [owner, randomUUID()]);
    expect(await call(request)).toMatchObject({ duplicate: true });
    await expect(call(send())).rejects.toThrow('account_deletion_write_blocked');
    expect(await call({ action: 'receipt', requestId: request.requestId, connectionId: connection })).toMatchObject({ status: 'committed' });
    expect(await createProductionCareMessageExport(database)({ ...context(), purpose: 'consent_management' }, { action: 'export', section: 'messages' })).toMatchObject({ records: [{ body: 'FICTIONAL patient message' }] });
  });
  it('refuses late direct receipt admission after settlement and rolls back the whole insertion', async () => {
    const result = await call(send());
    if (result.action !== 'send') throw new Error('wrong response');
    const requestId = randomUUID(), messageId = randomUUID();
    await call({ action: 'settle', requestId, connectionId: connection });
    await expect(db.transaction(async tx => {
      await tx.query("insert into clinical_core.messages(id,organization_id,conversation_id,sender_person_id,body,status,channel) values($1,$2,$3,$4,'FICTIONAL late','stored','alp_in_app')", [messageId, org, result.threadId, owner]);
      await tx.query('insert into clinical_core.care_message_receipts(sender_id,request_id,conversation_id,message_id,sender_pool,command_sha256) values($1,$2,$3,$4,$5,$6)', [owner, requestId, result.threadId, messageId, 'consumer', 'b'.repeat(64)]);
    })).rejects.toThrow('care_message_settled');
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_core.messages where id=$1', [messageId])).rows[0].n).toBe(0);
  });
  it('pages Unicode messages under a byte budget with no duplicate or missing records', async () => {
    const first = await call(send());
    if (first.action !== 'send') throw new Error('wrong response');
    const expected = new Set([first.messageId]);
    for (let i = 0; i < 38; i++) {
      const result = await call({ action: 'send', requestId: randomUUID(), connectionId: connection, threadId: first.threadId,
        body: '漢'.repeat(3900), acknowledgement: 'care-messages/1' });
      if (result.action !== 'send') throw new Error('wrong response');
      expected.add(result.messageId);
    }
    const seen = new Set<string>(); let before: string | undefined; let pages = 0;
    do {
      const result = await createProductionCareMessageExport(database)({ ...context(), purpose: 'consent_management' }, { action: 'export', section: 'messages', ...(before ? { before } : {}) });
      if (result.section !== 'messages') throw new Error('wrong response');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(132000);
      for (const record of result.records) { expect(seen.has(record.messageId)).toBe(false); seen.add(record.messageId); }
      before = result.nextBefore ?? undefined; pages++;
      expect(pages).toBeLessThan(10);
    } while (before);
    expect(pages).toBeGreaterThan(1); expect(seen).toEqual(expected);
  }, 15000);
  it('bounds ordinary thread reads too, including heavily escaped bodies', async () => {
    const first = await call(send());
    if (first.action !== 'send') throw new Error('wrong response');
    const expected = new Set([first.messageId]);
    for (let i = 0; i < 10; i++) {
      const result = await call({ action: 'send', requestId: randomUUID(), connectionId: connection, threadId: first.threadId,
        body: '\u0001'.repeat(3000), acknowledgement: 'care-messages/1' });
      if (result.action !== 'send') throw new Error('wrong response'); expected.add(result.messageId);
    }
    const seen = new Set<string>(); let before: string | undefined; let pages = 0;
    do {
      const result = await call({ action: 'read', threadId: first.threadId, ...(before ? { before } : {}) });
      if (result.action !== 'read') throw new Error('wrong response');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(132000);
      for (const message of result.messages) { expect(seen.has(message.messageId)).toBe(false); seen.add(message.messageId); }
      before = result.nextBefore ?? undefined; pages++; expect(pages).toBeLessThan(10);
    } while (before);
    expect(pages).toBeGreaterThan(1); expect(seen).toEqual(expected);
  });
});
