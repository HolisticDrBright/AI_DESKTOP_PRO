import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { createCareMessagingHandler, type CareMessagingBuild } from './care-messaging-deployment';
import { CURRENT_MEMBERSHIP_SETTER_BODY_SHA256 } from './current-membership-workforce';
import type { ClinicalCoreDatabase } from './database';
import { classifyDatabaseRejection } from './rds-data-database';

// Patient–practitioner messages under the unactivated `database_current` workforce authority: the real deployment
// handler, the real messaging API and the canonical production messaging SQL, plus the UNREGISTERED current-membership
// setter, in PGlite with fictional rows. Nothing here registers, applies or deploys SQL, and nothing is hosted evidence.
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const SETTER_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context-rollback.sql';
const WORKFORCE_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce';
const CONSUMER_ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer';
const REVIEW = '2'.repeat(64);
const CLINIC = randomUUID(), SECOND = randomUUID();
const member = () => ({ person: randomUUID(), sub: randomUUID() });
const practitioner = member(), colleague = member(), staff = member(), applicant = member(), outsider = member();
const patientOwner = member(), otherOwner = member(), foreignOwner = member(), withdrawingOwner = member();

let db: PGlite;
let build: CareMessagingBuild;
let outage = false;
let afterBinding: ((tx: Transaction) => Promise<void>) | undefined;
let transactions = 0;
const queries: string[] = [];
const unwrap = (v: unknown) => v && typeof v === 'object' && 'kind' in v && v.kind === 'uuid' && 'value' in v ? v.value : v;
const database: ClinicalCoreDatabase = { transaction: async work => {
  transactions += 1;
  if (outage) throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
  try {
    return await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      return work({ query: async (sql: string, args: readonly unknown[] = []) => {
        queries.push(sql);
        const result = await tx.query(sql, args.map(unwrap));
        if (sql.startsWith('select clinical_private.set_current_workforce_context(') && afterBinding) await afterBinding(tx);
        return result as never;
      } });
    });
  } catch (cause) {
    throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: cause instanceof Error ? cause.message : String(cause) }) ?? cause;
  }
} };

const environment = (authority?: string) => ({ SOURCE_COMMIT: '1'.repeat(40), MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256,
  AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked',
  CONSUMER_ISSUER, CONSUMER_AUDIENCE: 'c'.repeat(26), WORKFORCE_ISSUER, WORKFORCE_AUDIENCE: 'w'.repeat(26),
  CARE_MESSAGING_ORGANIZATION_ID: CLINIC, CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
  CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-AbCd12', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
  DATABASE_REVIEW_SHA256: REVIEW, WORKFORCE_MFA_REVIEW_SHA256: REVIEW, MESSAGING_REVIEW_SHA256: REVIEW, RETENTION_REVIEW_SHA256: REVIEW,
  QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: REVIEW, QUALIFICATION_ACCOUNT_ID: '588966314750',
  QUALIFICATION_IDENTITY_SUBJECTS: [practitioner, colleague, staff, applicant, outsider, patientOwner, otherOwner, foreignOwner, withdrawingOwner].map(w => w.sub).join(','),
  ...(authority === undefined ? {} : { CARE_MESSAGING_WORKFORCE_AUTHORITY: authority }) });
let handler: (event: ApiGatewayV2Event) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
let legacyHandler: typeof handler;

type Call = { sub: string; clinic?: string | null; claims?: Record<string, unknown>; headers?: Record<string, string> };
function workforce(body: unknown, call: Call): ApiGatewayV2Event {
  const now = Math.floor(Date.now() / 1000);
  return { routeKey: 'POST /clinical-core/workforce/messages',
    headers: { 'content-type': 'application/json', ...(call.clinic === null ? {} : { 'x-alp-selected-organization-id': call.clinic ?? CLINIC }), ...call.headers },
    body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: WORKFORCE_ISSUER, aud: 'w'.repeat(26), token_use: 'id', sub: call.sub,
      email_verified: 'true', iat: now - 10, exp: now + 1000, auth_time: now - 10, ...call.claims } } } } };
}
function consumer(body: unknown, who: { person: string; sub: string }): ApiGatewayV2Event {
  const now = Math.floor(Date.now() / 1000);
  return { routeKey: 'POST /clinical-core/consumer/messages', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: CONSUMER_ISSUER, aud: 'c'.repeat(26), sub: who.sub, token_use: 'id',
      'custom:person_id': who.person, 'custom:organization_id': CLINIC, 'custom:production_bound': 'true', email_verified: 'true',
      iat: now - 10, exp: now + 1000, auth_time: now - 10 } } } } };
}
async function call(event: ApiGatewayV2Event, via = handler) {
  const result = await via(event);
  return { status: result.statusCode, clinic: result.headers?.['x-alp-selected-organization-id'], body: JSON.parse(result.body) as { data?: Record<string, unknown>; error?: string } };
}
const asPractitioner = (body: unknown, extra: Partial<Call> = {}) => call(workforce(body, { sub: practitioner.sub, ...extra }));
const send = (connectionId: string, extra: Record<string, unknown> = {}) => ({ action: 'send', requestId: randomUUID(), connectionId,
  body: 'FICTIONAL care team reply', acknowledgement: 'care-messages/1', ...extra });
const count = async (sql: string, args: unknown[] = []) => Number((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, args)).rows[0]!.n);
const setterCalls = () => queries.filter(sql => sql.startsWith('select clinical_private.set_current_workforce_context(')).length;
const claimedContexts = () => queries.filter(sql => sql.includes('set_request_context')).length;
const membership = (who: { person: string }, clinic: string, set: string) =>
  db.query(`update clinical_core.organization_memberships set ${set} where organization_id=$1 and person_id=$2`, [clinic, who.person]);

let connection: string, otherConnection: string, foreignConnection: string;
let threadId: string;
async function linkPatient(owner: { person: string }, clinic: string) {
  const record = randomUUID(), link = randomUUID(), artifact = randomUUID();
  await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
    [record, clinic, 'patient_' + record.replaceAll('-', '')]);
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())",
    [link, clinic, record, owner.person]);
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'messaging',$5,$3,'TEST','approved',now(),$4)`, [artifact, clinic, 'a'.repeat(64), practitioner.person, 'fictional-' + artifact]);
  await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
    representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [clinic, record, link, artifact, owner.person]);
  return { record, link, artifact };
}

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000 }));
  expect(manifest.migrations.some((m: { file: string }) => m.file.includes('current-membership'))).toBe(false);
  const sql: string = files['20261006010000_production_care_messaging.sql'];
  build = { sourceCommit: '1'.repeat(40), sourceClean: true, migrationCount: 106,
    migrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b',
    functions: [...sql.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, schema, name, body]) => ({ schema, name, sha256: createHash('sha256').update(body).digest('hex'), callable: schema === 'clinical_core' })) };
  db = new PGlite({ extensions: { pgcrypto } });
  for (const m of manifest.migrations) await db.exec(files[m.file]);
  await db.exec(readFileSync(SETTER, 'utf8'));
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC'),($2,'FICTIONAL SECOND CLINIC')", [CLINIC, SECOND]);
  for (const [who, pool] of [[practitioner, 'workforce'], [colleague, 'workforce'], [staff, 'workforce'], [applicant, 'workforce'],
    [outsider, 'workforce'], [patientOwner, 'consumer'], [otherOwner, 'consumer'], [foreignOwner, 'consumer'], [withdrawingOwner, 'consumer']] as const) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, 'subject_' + who.person.replaceAll('-', '')]);
    await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [who.person, pool, who.sub]);
  }
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values
    ($1,$3,'practitioner','active'),($2,$3,'practitioner','active'),($1,$4,'practitioner','active'),($1,$5,'staff','active'),
    ($1,$6,'practitioner','pending'),($2,$7,'practitioner','active')`,
  [CLINIC, SECOND, practitioner.person, colleague.person, staff.person, applicant.person, outsider.person]);
  ({ link: connection } = await linkPatient(patientOwner, CLINIC));
  ({ link: otherConnection } = await linkPatient(otherOwner, CLINIC));
  ({ link: foreignConnection } = await linkPatient(foreignOwner, SECOND));
  handler = createCareMessagingHandler(environment('database_current'), build, () => database) as typeof handler;
  legacyHandler = createCareMessagingHandler(environment(), build, () => database) as typeof handler;
  // The patient opens the conversation from the app (the consumer route is unchanged by the workforce authority).
  const opened = await call(consumer({ action: 'send', requestId: randomUUID(), connectionId: connection, subject: 'Fictional question',
    body: 'FICTIONAL patient message', acknowledgement: 'care-messages/1' }, patientOwner));
  expect(opened.status).toBe(200);
  threadId = opened.body.data!.threadId as string;
}, 120000);
afterAll(async () => { await db?.close(); });
beforeEach(() => { outage = false; afterBinding = undefined; transactions = 0; queries.length = 0; });

describe('a practitioner with one selected clinic', () => {
  it('lists, reads and replies from current rows in one transaction, and the answer names the clinic it was decided in', async () => {
    const listed = await asPractitioner({ action: 'list' });
    expect(listed).toMatchObject({ status: 200, clinic: CLINIC });
    expect((listed.body.data!.threads as { threadId: string }[]).map(t => t.threadId)).toContain(threadId);
    expect(await asPractitioner({ action: 'read', threadId })).toMatchObject({ status: 200, clinic: CLINIC });
    const replied = await asPractitioner(send(connection, { threadId }));
    expect(replied).toMatchObject({ status: 200, clinic: CLINIC, body: { data: { action: 'send', duplicate: false, status: 'stored' } } });
    expect((await db.query('select sender_person_id from clinical_core.messages where id=$1', [replied.body.data!.messageId])).rows)
      .toEqual([{ sender_person_id: practitioner.person }]);
    expect(setterCalls()).toBe(3);
    expect(claimedContexts()).toBe(0);
    // The patient sees the reply in the same thread.
    const read = await call(consumer({ action: 'read', threadId }, patientOwner));
    expect((read.body.data!.messages as { sender: string }[]).map(m => m.sender)).toContain('workforce');
  });

  it('ignores person, clinic, role and production claims: the subject current rows decide', async () => {
    const forged = { 'custom:person_id': colleague.person, 'custom:organization_id': SECOND, 'custom:role': 'owner',
      'custom:production_bound': 'false', 'cognito:groups': 'owner' };
    const replied = await asPractitioner(send(connection, { threadId }), { claims: forged });
    expect(replied.status).toBe(200);
    expect((await db.query('select sender_person_id from clinical_core.messages where id=$1', [replied.body.data!.messageId])).rows)
      .toEqual([{ sender_person_id: practitioner.person }]);
    // A staff member claiming the practitioner role still has only the staff role current rows hold.
    expect(await call(workforce(send(connection, { threadId }), { sub: staff.sub, claims: { 'custom:role': 'practitioner' } })))
      .toMatchObject({ status: 403, body: { error: 'identity_refused' } });
  });
});

describe('the selected clinic', () => {
  it('another clinic selected in a second tab is refused at the handler, with no database transaction', async () => {
    for (const headers of [{ clinic: SECOND }, { clinic: null }, { clinic: 'not-a-uuid' },
      { headers: { 'X-Alp-Selected-Organization-Id': SECOND } }, { clinic: `${CLINIC},${SECOND}` }]) {
      expect(await asPractitioner({ action: 'list' }, headers)).toMatchObject({ status: 403, body: { error: 'identity_refused' } });
    }
    expect(transactions).toBe(0);
  });

  it('a member of only another clinic, a pending applicant and an unlinked subject are refused by current rows', async () => {
    for (const sub of [outsider.sub, applicant.sub, randomUUID()]) {
      expect(await call(workforce({ action: 'list' }, { sub }))).toMatchObject({ status: sub === applicant.sub || sub === outsider.sub ? 403 : 503 });
    }
    const before = await count('clinical_core.messages');
    expect(await call(workforce(send(connection, { threadId }), { sub: outsider.sub }))).toMatchObject({ status: 403 });
    expect(await count('clinical_core.messages')).toBe(before);
  });

  it('a suspended or removed membership is refused on the next request, and restored access works again', async () => {
    await membership(colleague, CLINIC, "status='suspended'");
    try {
      expect(await call(workforce({ action: 'list' }, { sub: colleague.sub }))).toMatchObject({ status: 403, body: { error: 'identity_refused' } });
    } finally { await membership(colleague, CLINIC, "status='active'"); }
    expect(await call(workforce({ action: 'list' }, { sub: colleague.sub }))).toMatchObject({ status: 200 });
    await db.query('delete from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [CLINIC, colleague.person]);
    try {
      expect(await call(workforce({ action: 'list' }, { sub: colleague.sub }))).toMatchObject({ status: 403 });
    } finally {
      await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'practitioner','active')", [CLINIC, colleague.person]);
    }
  });

  it('a suspension inside the transaction after binding refuses the reply and keeps nothing', async () => {
    const before = await count('clinical_core.messages');
    // An operator's suspension, made in the request's own transaction after the binding (the API role cannot write it).
    afterBinding = async tx => {
      await tx.exec('reset role');
      await tx.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [CLINIC, practitioner.person]);
      await tx.exec('set local role clinical_core_api');
    };
    expect(await asPractitioner(send(connection, { threadId }))).toMatchObject({ status: 403 });
    expect(await count('clinical_core.messages')).toBe(before);
    expect((await db.query('select status from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [CLINIC, practitioner.person])).rows)
      .toEqual([{ status: 'active' }]);
  });
});

describe('the patient and connection', () => {
  it('a connection or thread of another clinic, or another patient, is refused', async () => {
    expect(await asPractitioner(send(foreignConnection, { subject: 'Fictional' }))).toMatchObject({ status: 403 });
    expect(await asPractitioner(send(otherConnection, { threadId }))).toMatchObject({ status: 403 });
    expect(await asPractitioner({ action: 'read', threadId: randomUUID() })).toMatchObject({ status: 403 });
    // A request cannot name a clinic in the body: the contract is strict.
    expect(await asPractitioner({ action: 'list', organizationId: SECOND })).toMatchObject({ status: 400, body: { error: 'request_invalid' } });
  });

  it('withdrawn messaging consent and a replaced connection keep their own refusals', async () => {
    const { record, link } = await linkPatient(withdrawingOwner, CLINIC);
    const opened = await call(consumer({ action: 'send', requestId: randomUUID(), connectionId: link, subject: 'Fictional',
      body: 'FICTIONAL', acknowledgement: 'care-messages/1' }, withdrawingOwner));
    const thread = opened.body.data!.threadId as string;
    await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'messaging','revoked','patient_app','self','patient_request',2,$4)`,
    [CLINIC, record, link, withdrawingOwner.person]);
    expect(await asPractitioner({ action: 'read', threadId: thread })).toMatchObject({ status: 403, body: { error: 'consent_required' } });
    await db.query("update clinical_core.patient_connections set state='revoked',revoked_at=clock_timestamp() where id=$1", [otherConnection]);
    try {
      expect(await asPractitioner(send(otherConnection, { subject: 'Fictional' }))).toMatchObject({ status: 403 });
    } finally { await db.query("update clinical_core.patient_connections set state='verified',revoked_at=null where id=$1", [otherConnection]); }
  });

  it('receipts and settlement stay the patient app\'s own', async () => {
    for (const action of ['receipt', 'settle']) {
      expect(await asPractitioner({ action, requestId: randomUUID(), connectionId: connection })).toMatchObject({ status: 403 });
    }
    expect(setterCalls()).toBe(0);
  });
});

describe('retries, cancellation and outages', () => {
  it('a retried reply after an interrupted request is the same message; the same request with another body is a conflict', async () => {
    const reply = send(connection, { threadId });
    const first = await asPractitioner(reply);
    const retried = await asPractitioner(reply);
    expect(retried).toMatchObject({ status: 200, body: { data: { duplicate: true, messageId: first.body.data!.messageId } } });
    expect(await asPractitioner({ ...reply, body: 'FICTIONAL different reply' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  it('an expired or stale sign-in asks for sign-in again before any database call', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await asPractitioner({ action: 'list' }, { claims: { exp: now - 1 } })).toMatchObject({ status: 401, body: { error: 'reauth_required' } });
    expect(await asPractitioner({ action: 'list' }, { claims: { auth_time: now - 3600, iat: now - 10 } })).toMatchObject({ status: 401 });
    expect(await asPractitioner({ action: 'list' }, { claims: { sub: 'subject-not-a-uuid' } })).toMatchObject({ status: 401 });
    expect(transactions).toBe(0);
  });

  it('a database outage is unavailable, never a claim fallback', async () => {
    outage = true;
    expect(await asPractitioner({ action: 'list' })).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    expect(claimedContexts()).toBe(0);
  });

  it('while the setter is not registered, every workforce request is unavailable before any message function runs', async () => {
    await db.exec(readFileSync(SETTER_ROLLBACK, 'utf8'));
    try {
      expect(await asPractitioner({ action: 'list' })).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
      expect(queries.some(sql => sql.includes('production_care_message_request'))).toBe(false);
    } finally { await db.exec(readFileSync(SETTER, 'utf8')); }
    expect(await asPractitioner({ action: 'list' })).toMatchObject({ status: 200 });
  });

  it('pins the reviewed setter body, and a changed body is refused like an absent one', async () => {
    const body = /as \$\$([\s\S]*?)\$\$;/.exec(readFileSync(SETTER, 'utf8'))![1]!;
    expect(createHash('sha256').update(body).digest('hex')).toBe(CURRENT_MEMBERSHIP_SETTER_BODY_SHA256);
    expect((await db.query<{ sha: string }>(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as sha from pg_proc
      where oid=to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')`)).rows).toEqual([{ sha: CURRENT_MEMBERSHIP_SETTER_BODY_SHA256 }]);
    await db.exec("alter function clinical_private.set_current_workforce_context(text,uuid,text) set search_path=public");
    try { expect(await asPractitioner({ action: 'list' })).toMatchObject({ status: 503 }); }
    finally { await db.exec("alter function clinical_private.set_current_workforce_context(text,uuid,text) set search_path=''"); }
  });
});

describe('unchanged outside the workforce route', () => {
  it('the legacy deployment reads claims and never calls the setter; an unknown authority setting refuses the deployment', async () => {
    const legacy = await call(workforce({ action: 'list' }, { sub: practitioner.sub, clinic: null,
      claims: { 'custom:person_id': practitioner.person, 'custom:organization_id': CLINIC, 'custom:production_bound': 'true' } }), legacyHandler);
    expect(legacy.status).toBe(200);
    expect(legacy.clinic).toBeUndefined();
    expect(setterCalls()).toBe(0);
    const misconfigured = createCareMessagingHandler(environment('database-current'), build, () => database);
    expect((await misconfigured(workforce({ action: 'list' }, { sub: practitioner.sub }))).statusCode).toBe(503);
  });

  it('the patient app keeps its own owner-bound route under database_current', async () => {
    expect(await call(consumer({ action: 'read', threadId }, patientOwner))).toMatchObject({ status: 200 });
    expect(await call(consumer({ action: 'read', threadId }, otherOwner))).toMatchObject({ status: 403 });
    expect(setterCalls()).toBe(0);
  });
});
