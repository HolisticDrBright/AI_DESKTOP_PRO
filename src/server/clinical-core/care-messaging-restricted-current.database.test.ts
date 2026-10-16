import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase, ClinicalCoreTransaction } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY, CARE_MESSAGING_QUALIFICATION_CURRENT_STATEMENTS, CARE_MESSAGING_QUALIFICATION_PROXIES,
  bindRestrictedCurrentCareMessagingDatabase, createRestrictedCareMessagingHandler, type CareMessagingBuild } from './care-messaging-deployment';
import { CURRENT_MEMBERSHIP_SETTER_BODY_SHA256, CURRENT_MEMBERSHIP_SETTER_STATEMENT } from './current-membership-workforce';

/**
 * The BLOCKED current-context successor (care-messaging-qualification-current-context.sql) over the real 112-migration
 * qualification schema, the BLOCKED restricted credential and the UNREGISTERED current-membership setter, in PGlite.
 * Messaging can now bind its own current workforce context through one fifth proxy; nothing else becomes reachable.
 * The race with a membership change committed mid-write needs two sessions: scripts/qualify-care-messaging-current-native.mjs.
 * Fictional rows only; not Aurora, the Data API, a provisioned secret or a hosted test.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const LOGIN_SQL = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql');
const LOGIN_ROLLBACK = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-login-rollback.sql');
const SETTER_SQL = read('infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql');
const CURRENT_SQL = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-current-context.sql');
const CURRENT_ROLLBACK = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-current-context-rollback.sql');
const API = 'clinical_care_messaging_qualification_api', LOGIN = 'clinical_care_messaging_qualification_login';
const SCHEMA = 'clinical_care_messaging_qualification';
let db: PGlite, database: string, build: CareMessagingBuild;
const scoped = (sql: string) => sql.replaceAll("current_database() <> 'clinical_core_qualification'", `current_database() <> '${database}'`);
const count = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]!.n);
const proxies = () => count(`select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='${SCHEMA}'`);
async function refused(sql: string, reason: RegExp, proxyCount: number) {
  await expect(db.exec(sql)).rejects.toThrow(reason);
  await db.exec('rollback');
  expect(await proxies()).toBe(proxyCount);
}
/** One transaction as the dedicated login running as its API role, the way the Data API would. */
const restricted: ClinicalCoreDatabase = { transaction: async work => db.transaction(async tx => {
  await tx.exec(`set local session authorization ${LOGIN}`);
  await tx.exec(`set local role ${API}`);
  return work({ query: async (sql: string, args: unknown[] = []) => {
    try { return await tx.query(sql, args.map(v => typeof v === 'object' && v !== null && 'kind' in v && 'value' in v ? (v as { value: unknown }).value : v)); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message }) ?? error;
    }
  } } as unknown as ClinicalCoreTransaction);
}) };

beforeAll(async () => {
  const successor = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));
  const migrations = successor.manifest.migrations.map((entry: { version: string; file: string }) => ({
    version: entry.version, name: entry.file.slice(15, -4), sql: successor.files[entry.file], sha256: sha(successor.files[entry.file]) }));
  const release = sha(successor.manifest.migrations.map((m: { version: string; file: string }) => `${m.version}:${sha(successor.files[m.file])}`).join('\n'));
  expect([migrations.length, release]).toEqual([112, '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4']);
  const messaging: string = successor.files['20261006010000_production_care_messaging.sql'];
  build = { sourceCommit: '1'.repeat(40), sourceClean: true, migrationCount: 112, migrationReleaseSha256: release,
    functions: [...messaging.matchAll(/create function (clinical_(?:core|private))\.(production_care_message_[a-z]+)\([^]*?security definer set search_path='' as \$\$([^]*?)\$\$/g)]
      .map(([, schema, name, body]) => ({ schema: schema!, name: name!, sha256: sha(body!), callable: schema === 'clinical_core' })) };
  db = new PGlite({ extensions: { pgcrypto } });
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, parameters = []) => tx.query(sql, [...parameters]) as never })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    await db.exec(entry.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  database = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('the successor is a new identity over unchanged parents', () => {
  it('the parent credential and its rollback keep their reviewed hashes; the fifth proxy body is the one the runtime binds', () => {
    expect(sha(LOGIN_SQL)).toBe('7936d0c536dd7224fe32a62489266da730f0202aac09dd30e7d5e466a4f19dac');
    expect(sha(LOGIN_ROLLBACK)).toBe('1b04682b1d9a26ad828fa4ee580e53893d25930c5e845e1555bf1c3de11940eb');
    const start = CURRENT_SQL.indexOf(`create function ${SCHEMA}.set_current_workforce_context(`);
    const bodyStart = CURRENT_SQL.indexOf('as $$', start) + 'as $$'.length;
    const body = CURRENT_SQL.slice(bodyStart, CURRENT_SQL.indexOf('$$;', bodyStart));
    expect(sha(body)).toBe(CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY.bodySha256);
    expect(body).toContain(`${CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY.target}(_subject, _selected_organization_id, 'clinical_data')`);
    expect((CURRENT_SQL.match(/^create function /gm) ?? []).length).toBe(1);
    for (const parent of CARE_MESSAGING_QUALIFICATION_PROXIES) {
      expect(CURRENT_SQL).toContain(`'${parent.bodySha256}'`);
      expect(CURRENT_ROLLBACK).toContain(`'${parent.bodySha256}'`);
    }
    expect(CURRENT_SQL).toContain(`'${CURRENT_MEMBERSHIP_SETTER_BODY_SHA256}'`);
    expect(CURRENT_ROLLBACK).toContain(CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY.bodySha256);
    // No credential, no global role, no clinical schema, no table grant.
    for (const file of [CURRENT_SQL, CURRENT_ROLLBACK]) {
      expect(file).not.toMatch(/\bpassword\b|\blogin\b\s*;|grant clinical_core_api|grant usage on schema clinical_(core|private|audit)|grant (select|insert|update|delete)/i);
    }
    expect([...CARE_MESSAGING_QUALIFICATION_CURRENT_STATEMENTS.values()].map(s => new RegExp(`${SCHEMA}\\.([a-z_]+)\\(`).exec(s.sql)?.[1] ?? 'contract').sort())
      .toEqual([...CARE_MESSAGING_QUALIFICATION_PROXIES.map(p => p.name), CARE_MESSAGING_QUALIFICATION_CURRENT_PROXY.name, 'contract'].sort());
  });
});

describe('the successor refuses and leaves nothing behind', () => {
  it('without the parent credential', async () => {
    await refused(scoped(CURRENT_SQL), /care_messaging_credential_parent_refused/, 0);
  });
  it('without the current-membership setter, or with a setter its role does not own', async () => {
    await db.exec(scoped(LOGIN_SQL));
    await refused(scoped(CURRENT_SQL), /current_membership_setter_refused/, 4);
    await db.exec(SETTER_SQL);
    await db.exec('alter function clinical_private.set_current_workforce_context(text,uuid,text) owner to clinical_core_migrator');
    try { await refused(scoped(CURRENT_SQL), /current_membership_setter_refused/, 4); }
    finally { await db.exec('alter function clinical_private.set_current_workforce_context(text,uuid,text) owner to postgres'); }
  });
  it('on any database but the qualification database', async () => {
    await refused(CURRENT_SQL, /qualification_database_refused/, 4);
  });
});

describe('applied: five proxies, and nothing else', () => {
  beforeAll(async () => { await db.exec(scoped(CURRENT_SQL)); });

  it('the API role executes exactly the five proxies; the setter stays out of reach except through its proxy', async () => {
    const reachable = await db.query<{ name: string }>(`select n.nspname||'.'||p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where has_function_privilege('${API}',p.oid,'EXECUTE') and has_schema_privilege('${API}',n.oid,'USAGE')
        and n.nspname not in ('pg_catalog','information_schema')
        and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e') order by 1`);
    expect(reachable.rows.map(r => r.name)).toEqual([...CARE_MESSAGING_QUALIFICATION_PROXIES.map(p => p.name), 'set_current_workforce_context']
      .map(name => `${SCHEMA}.${name}`).sort());
    expect(await count(`select count(*)::integer as n from pg_proc p where p.oid=to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')
      and has_function_privilege('${API}',p.oid,'EXECUTE')`)).toBe(0);
    expect(await count(`select count(*)::integer as n from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname in ('${API}','${LOGIN}')`)).toBe(1);
  });

  const UNRELATED = [
    ['chart', 'clinical_core.create_patient_profile(uuid,text,text,date,text,text,text,text)'], ['clinic', 'clinical_core.list_my_organizations()'],
    ['clinic', 'clinical_core.remove_org_member(uuid)'], ['program', 'clinical_core.invoke_program_operation(text,jsonb)'],
    ['privacy', 'clinical_core.request_owned_privacy_export_job(uuid,text)'],
    ['operator', 'clinical_private.reconcile_privacy_export_by_operator(uuid,uuid,bigint,boolean)'],
    ['setter without proxy', 'clinical_private.set_current_workforce_context(text,uuid,text)'],
    ['legacy context without proxy', 'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'],
  ] as const;
  it.each(UNRELATED)('%s: %s is refused to the care-messaging role', async (_family, signature) => {
    const found = await db.query<{ oid: number | null; args: number }>(`select to_regprocedure($1)::oid as oid,
      (select pronargs from pg_proc where oid = to_regprocedure($1)) as args`, [signature]);
    expect(found.rows[0]!.oid, signature).not.toBeNull();
    const call = `select ${signature.slice(0, signature.indexOf('('))}(${Array.from({ length: Number(found.rows[0]!.args) }, () => 'null').join(',')})`;
    await db.exec(`set session authorization ${LOGIN}`);
    try {
      await db.exec(`set role ${API}`);
      await expect(db.query(call)).rejects.toThrow(/permission denied/);
    } finally { await db.exec('reset role'); await db.exec('set session authorization postgres'); }
  });
});

describe('applied: messaging under database_current through the restricted role', () => {
  let org: string, sibling: string, owner: string, staff: string, siblingStaff: string, patient: string, connection: string, artifact: string;
  const subjects = new Map<string, string>();
  const subject = (person: string) => subjects.get(person)!;
  const now = Date.now(), review = '2'.repeat(64);
  const SECRET = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-AbCd12';
  const environment = (over: Record<string, string> = {}) => ({ SOURCE_COMMIT: build.sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256,
    AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked',
    CARE_MESSAGING_DATABASE_CREDENTIAL: 'restricted_qualification_current', CARE_MESSAGING_WORKFORCE_AUTHORITY: 'database_current',
    CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
    WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
    CARE_MESSAGING_ORGANIZATION_ID: org, CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    CLINICAL_DATABASE_SECRET_ARN: SECRET, CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
    QUALIFICATION_IDENTITY_SUBJECTS: [owner, staff, siblingStaff].map(subject).join(','), ...over });
  const consumer = (body: unknown): ApiGatewayV2Event => ({ routeKey: 'POST /clinical-core/consumer/messages', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { iss: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer',
      aud: 'c'.repeat(26), sub: subject(owner), 'custom:person_id': owner, 'custom:organization_id': org, 'custom:production_bound': 'true',
      email_verified: 'true', token_use: 'id', iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } } } as ApiGatewayV2Event);
  /** A current-membership workforce request: no person or clinic claim is read, only the subject and the selected clinic. */
  const workforce = (body: unknown, who: string, selected = org): ApiGatewayV2Event => ({ routeKey: 'POST /clinical-core/workforce/messages',
    headers: { 'content-type': 'application/json', 'x-alp-selected-organization-id': selected }, body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { iss: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', aud: 'w'.repeat(26),
      sub: subject(who), email_verified: 'true', token_use: 'id', iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000,
      auth_time: Math.floor(now / 1000) - 10 } } } } } as ApiGatewayV2Event);
  let threadId: string;
  const reply = () => ({ action: 'send' as const, requestId: randomUUID(), connectionId: connection, threadId, body: 'FICTIONAL practitioner reply',
    acknowledgement: 'care-messages/1' as const });
  const replies = () => count(`select count(*)::integer as n from clinical_core.messages where body='FICTIONAL practitioner reply'`);

  beforeAll(async () => {
    [org, sibling, owner, staff, siblingStaff, patient, connection, artifact] = Array.from({ length: 8 }, () => randomUUID());
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL'),($2,'FICTIONAL sibling')", [org, sibling]);
    for (const [id, pool] of [[owner, 'consumer'], [staff, 'workforce'], [siblingStaff, 'workforce']] as const) {
      subjects.set(id, randomUUID());
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id)]);
    }
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($3,$4,'practitioner')",
      [org, staff, sibling, siblingStaff]);
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Test')", [patient, org, 'patient_test_' + patient.replaceAll('-', '')]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [connection, org, patient, owner]);
    await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'messaging','fictional-local-test',$3,'TEST','approved',now(),$4)`, [artifact, org, 'a'.repeat(64), staff]);
    await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
      representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',1,$5)`, [org, patient, connection, artifact, owner]);
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const sent = await handler(consumer({ action: 'send', requestId: randomUUID(), connectionId: connection, subject: 'Fictional question',
      body: 'FICTIONAL patient message', acknowledgement: 'care-messages/1' }));
    expect(sent).toMatchObject({ statusCode: 200 });
    threadId = JSON.parse(sent.body).data.threadId;
  });

  it('the practitioner reads and replies in the selected clinic, bound from current rows; the answer names that clinic', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const read = await handler(workforce({ action: 'read', threadId }, staff));
    expect(read).toMatchObject({ statusCode: 200, headers: { 'x-alp-selected-organization-id': org } });
    expect(read.body).toContain('FICTIONAL patient message');
    expect(await handler(workforce(reply(), staff))).toMatchObject({ statusCode: 200 });
    expect(await replies()).toBe(1);
  });

  it('cross-clinic: a practitioner of the sibling clinic selecting this one, and a selection of the sibling clinic, are refused', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const before = await replies();
    for (const [event, label] of [[workforce({ action: 'read', threadId }, siblingStaff), 'sibling practitioner'],
      [workforce(reply(), siblingStaff), 'sibling practitioner reply'], [workforce({ action: 'read', threadId }, staff, sibling), 'sibling selected']] as const) {
      const answer = await handler(event);
      expect(answer.statusCode, label).toBe(403);
      expect(answer.body, label).not.toContain('FICTIONAL');
    }
    expect(await replies()).toBe(before);
  });

  it('a removed membership and a suspended clinic are refused on the next request; restoring them restores access', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const before = await replies();
    for (const [change, restore] of [
      [`update clinical_core.organization_memberships set status='suspended' where organization_id='${org}' and person_id='${staff}'`,
        `update clinical_core.organization_memberships set status='active' where organization_id='${org}' and person_id='${staff}'`],
      [`update clinical_core.organizations set status='suspended' where id='${org}'`, `update clinical_core.organizations set status='active' where id='${org}'`],
    ]) {
      await db.exec(change);
      try {
        expect(await handler(workforce({ action: 'read', threadId }, staff)), change).toMatchObject({ statusCode: 403 });
        expect(await handler(workforce(reply(), staff)), change).toMatchObject({ statusCode: 403 });
      } finally { await db.exec(restore); }
    }
    expect(await replies()).toBe(before);
    expect(await handler(workforce({ action: 'read', threadId }, staff))).toMatchObject({ statusCode: 200 });
  });

  it('the parent credential still refuses database_current, and this credential refuses legacy claims', async () => {
    const overrides: Array<Record<string, string>> = [{ CARE_MESSAGING_DATABASE_CREDENTIAL: 'restricted_qualification' },
      { CARE_MESSAGING_WORKFORCE_AUTHORITY: 'legacy_claims' }, { CARE_MESSAGING_WORKFORCE_AUTHORITY: '' }, { CARE_MESSAGING_DATABASE_CREDENTIAL: '' }];
    for (const over of overrides) {
      let constructed = 0;
      const handler = createRestrictedCareMessagingHandler(environment(over), build, () => { constructed += 1; return restricted; }, () => now);
      expect(await handler(workforce({ action: 'read', threadId }, staff)), JSON.stringify(over)).toMatchObject({ statusCode: 503 });
      expect(constructed).toBe(0);
    }
  });

  it('drift in the setter, its reach or the fifth proxy stops the service before any business SQL', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const drifts = [
      [`grant execute on function clinical_private.set_current_workforce_context(text,uuid,text) to ${API}`,
        `revoke execute on function clinical_private.set_current_workforce_context(text,uuid,text) from ${API}`],
      [`alter function ${SCHEMA}.set_current_workforce_context(text,uuid) set search_path = public`,
        `alter function ${SCHEMA}.set_current_workforce_context(text,uuid) set search_path = ''`],
      [`revoke execute on function ${SCHEMA}.set_current_workforce_context(text,uuid) from ${API}`,
        `grant execute on function ${SCHEMA}.set_current_workforce_context(text,uuid) to ${API}`],
      [`alter function clinical_private.set_current_workforce_context(text,uuid,text) security invoker`,
        `alter function clinical_private.set_current_workforce_context(text,uuid,text) security definer`],
    ];
    for (const [change, restore] of drifts) {
      await db.exec(change!);
      try { expect(await handler(workforce({ action: 'read', threadId }, staff)), change).toMatchObject({ statusCode: 503 }); }
      finally { await db.exec(restore!); }
    }
    expect(await handler(workforce({ action: 'read', threadId }, staff))).toMatchObject({ statusCode: 200 });
  });

  it('consent withdrawal: the patient and the practitioner are refused, and nothing is written', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const before = await replies();
    await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'messaging','revoked','patient_app','self','patient_request',2,$4)`, [org, patient, connection, owner]);
    expect(await handler(consumer({ action: 'read', threadId }))).toMatchObject({ statusCode: 403 });
    const refusedReply = await handler(workforce(reply(), staff));
    expect(refusedReply.statusCode).toBe(403);
    expect(await replies()).toBe(before);
  });

  it('only messaging\'s own statements reach the proxies, and the setter only with messaging\'s purpose', async () => {
    const sent: string[] = [];
    const spy: ClinicalCoreDatabase = { transaction: work => restricted.transaction(tx => work({ query: (sql, args) => { sent.push(sql); return tx.query(sql, args); } })) };
    const guarded = bindRestrictedCurrentCareMessagingDatabase(spy, build);
    for (const purpose of ['consent_management', 'identity_link']) {
      await expect(guarded.transaction(tx => tx.query(CURRENT_MEMBERSHIP_SETTER_STATEMENT, [subject(staff), org, purpose]))).rejects.toThrow('service_unavailable');
    }
    await expect(guarded.transaction(tx => tx.query('select clinical_core.create_patient_profile($1,$2,$3)', [org, 'a', 'b']))).rejects.toThrow('service_unavailable');
    expect(sent).toHaveLength(3);
    expect(sent.every(sql => sql.startsWith('with expected as ('))).toBe(true);
    const bound = await guarded.transaction(tx => tx.query<{ binding: unknown }>(CURRENT_MEMBERSHIP_SETTER_STATEMENT, [subject(staff), org, 'clinical_data']));
    expect(bound.rows[0]?.binding).toMatchObject({ organizationId: org, role: 'practitioner' });
  });
});

describe('the rollbacks remove exactly what each added', () => {
  it('the successor\'s rollback refuses drift, then removes the fifth proxy only; the parent rollback then applies', async () => {
    await db.exec(`grant execute on function ${SCHEMA}.set_current_workforce_context(text,uuid) to ${LOGIN}`);
    try { await refused(scoped(CURRENT_ROLLBACK), /current_context_rollback_refused/, 5); }
    finally { await db.exec(`revoke execute on function ${SCHEMA}.set_current_workforce_context(text,uuid) from ${LOGIN}`); }
    await refused(CURRENT_ROLLBACK, /qualification_database_refused/, 5);
    await db.exec(scoped(CURRENT_ROLLBACK));
    expect(await proxies()).toBe(4);
    expect((await db.query<{ body: string }>(`select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as body from pg_proc p join pg_namespace n
      on n.oid=p.pronamespace where n.nspname='${SCHEMA}' order by 1`)).rows.map(r => r.body))
      .toEqual(CARE_MESSAGING_QUALIFICATION_PROXIES.map(p => p.bodySha256).sort());
    await refused(scoped(CURRENT_ROLLBACK), /current_context_rollback_refused/, 4);
    await db.exec(scoped(LOGIN_ROLLBACK));
    expect(await count("select count(*)::integer as n from pg_roles where rolname like 'clinical_care_messaging_qualification_%'")).toBe(0);
    expect(await count(`select count(*)::integer as n from pg_namespace where nspname='${SCHEMA}'`)).toBe(0);
    // The setter candidate is its own; neither rollback touches it.
    expect(await count(`select count(*)::integer as n from pg_proc where oid=to_regprocedure('clinical_private.set_current_workforce_context(text,uuid,text)')`)).toBe(1);
  });
});
