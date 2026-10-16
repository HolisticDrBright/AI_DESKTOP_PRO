import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ApiGatewayV2Event } from './aws-identity-api';
import { CARE_MESSAGING_QUALIFICATION_PROXIES, CARE_MESSAGING_QUALIFICATION_STATEMENTS, bindRestrictedCareMessagingDatabase,
  createRestrictedCareMessagingHandler, type CareMessagingBuild } from './care-messaging-deployment';

/**
 * The BLOCKED care-messaging credential candidate against the real 112-migration qualification schema in PGlite.
 * Fictional rows only. This is source evidence for the SQL shape and the runtime binding; it is not Aurora, the Data
 * API, a provisioned secret or a hosted refusal test, and nothing here creates a login.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const LOGIN_SQL = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql');
const ROLLBACK_SQL = read('infra/aws-clinical-core/source-candidates/care-messaging-qualification-login-rollback.sql');
const API = 'clinical_care_messaging_qualification_api', LOGIN = 'clinical_care_messaging_qualification_login';
let db: PGlite;
let database: string;
let build: CareMessagingBuild;
const scoped = (sql: string) => sql.replaceAll("current_database() <> 'clinical_core_qualification'", `current_database() <> '${database}'`);
const count = async (sql: string, args: unknown[] = []) => Number((await db.query<{ n: number }>(sql, args)).rows[0]!.n);
const rolesLeft = () => count("select count(*)::integer as n from pg_roles where rolname like 'clinical_care_messaging_qualification_%'");
const schemaLeft = () => count("select count(*)::integer as n from pg_namespace where nspname='clinical_care_messaging_qualification'");
/** Apply SQL expected to fail, then clear the aborted transaction it leaves, as an operator's session would. */
async function refused(sql: string, reason: RegExp) {
  await expect(db.exec(sql)).rejects.toThrow(reason);
  await db.exec('rollback');
  expect(await rolesLeft()).toBe(0);
  expect(await schemaLeft()).toBe(0);
}
/** One transaction signed in as the dedicated login and running as its API role, the way the Data API would. In PGlite
 * a session-level RESET SESSION AUTHORIZATION does not return to the superuser, so sessions are restored by name. */
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

describe('the candidate binds exactly the reviewed proxies', () => {
  it('the runtime binding, the rollback and the SQL name the same four proxy bodies', () => {
    for (const proxy of CARE_MESSAGING_QUALIFICATION_PROXIES) {
      const start = LOGIN_SQL.indexOf(`create function clinical_care_messaging_qualification.${proxy.name}(`);
      expect(start).toBeGreaterThan(0);
      const bodyStart = LOGIN_SQL.indexOf('as $$', start) + 'as $$'.length;
      const body = LOGIN_SQL.slice(bodyStart, LOGIN_SQL.indexOf('$$;', bodyStart));
      expect(sha(body)).toBe(proxy.bodySha256);
      expect(body).toContain(`${proxy.target}(`);
      expect(ROLLBACK_SQL).toContain(`'${proxy.bodySha256}'`);
    }
    expect((LOGIN_SQL.match(/^create function /gm) ?? []).length).toBe(4);
    // No usable credential and no global role: the file creates NOLOGIN roles and grants no clinical schema.
    expect(LOGIN_SQL).not.toMatch(/\bpassword\b\s*'/i);
    expect(LOGIN_SQL).not.toMatch(/^\s*create role [a-z_]+\s+login/im);
    expect(LOGIN_SQL).not.toMatch(/grant clinical_core_api to/i);
    expect(LOGIN_SQL).not.toMatch(/grant usage on schema clinical_(core|private|audit)/i);
    // Each statement the service sends is rewritten to its own proxy and nothing else.
    expect([...CARE_MESSAGING_QUALIFICATION_STATEMENTS.values()].map(s => /clinical_care_messaging_qualification\.([a-z_]+)\(/.exec(s)?.[1]).sort())
      .toEqual(CARE_MESSAGING_QUALIFICATION_PROXIES.map(p => p.name).sort());
  });
});

describe('the candidate refuses and leaves nothing behind', () => {
  it('a database other than the qualification database', async () => {
    await refused(LOGIN_SQL, /qualification_database_refused/);
  });
  it('a sibling database the login could reach through PUBLIC CONNECT (the CONNECT isolation has not run)', async () => {
    await db.exec("update pg_database set datistemplate = false where datname = 'template1'");
    try { await refused(scoped(LOGIN_SQL), /sibling_database_connect_refused/); }
    finally { await db.exec("update pg_database set datistemplate = true where datname = 'template1'"); }
  });
  it('broad schema USAGE given to PUBLIC, which would reach every function PUBLIC may execute there', async () => {
    await db.exec('grant usage on schema clinical_private to public');
    try { await refused(scoped(LOGIN_SQL), /care_messaging_schema_usage_refused/); }
    finally { await db.exec('revoke usage on schema clinical_private from public'); }
  });
  it('a target the executing role does not own, so a proxy would run with privileges its target lacks', async () => {
    await db.exec('alter function clinical_core.production_care_message_export(jsonb) owner to clinical_core_migrator');
    try { await refused(scoped(LOGIN_SQL), /care_messaging_targets_refused/); }
    finally { await db.exec('alter function clinical_core.production_care_message_export(jsonb) owner to postgres'); }
  });
  it('a late failure: roles, schema and executable proxies roll back together', async () => {
    expect(LOGIN_SQL).toMatch(/^begin;\s*do \$\$/m);
    expect(LOGIN_SQL).toMatch(/\bcommit;\s*$/);
    await refused(scoped(LOGIN_SQL).replace(`grant ${API} to ${LOGIN}`, `grant nonexistent_care_role to ${LOGIN}`), /nonexistent_care_role/);
  });
});

describe('applied: the login reaches four proxies and nothing else', () => {
  beforeAll(async () => {
    await db.exec(scoped(LOGIN_SQL));
  });

  it('both roles start disabled, and the only membership is login to API with SET alone', async () => {
    const roles = await db.query(`select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname like 'clinical_care_messaging_qualification_%' order by rolname`);
    expect(roles.rows).toEqual([API, LOGIN].map(rolname => ({ rolname, rolcanlogin: false, rolinherit: false, rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false })));
    const edges = await db.query(`with recursive reach(oid) as (select oid from pg_roles where rolname = '${LOGIN}'
        union select m.roleid from pg_auth_members m join reach r on r.oid = m.member)
      select r.rolname from reach join pg_roles r on r.oid = reach.oid order by 1`);
    expect(edges.rows).toEqual([{ rolname: API }, { rolname: LOGIN }]);
    expect(await count(`select count(*)::integer as n from pg_auth_members m join pg_roles r on r.oid = m.member
      where r.rolname = '${LOGIN}' and not m.admin_option and not m.inherit_option and m.set_option`)).toBe(1);
  });

  it('the login cannot become the global API role, the migrator or a worker', async () => {
    await db.exec(`set session authorization ${LOGIN}`);
    try {
      for (const role of ['clinical_core_api', 'clinical_core_migrator', 'clinical_sync_worker', 'fullscript_draft_worker', 'postgres']) {
        await expect(db.exec(`set role ${role}`), role).rejects.toThrow(/permission denied/);
      }
      await db.exec(`set role ${API}`);
      expect((await db.query<{ name: string }>('select current_user as name')).rows[0]!.name).toBe(API);
    } finally { await db.exec('reset role'); await db.exec('set session authorization postgres'); }
  });

  it('no function outside the four proxies is executable (pgcrypto in public excepted), and no table is readable', async () => {
    expect(await count(`select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('clinical_care_messaging_qualification','pg_catalog','information_schema')
        and has_schema_privilege('${API}', n.oid, 'USAGE') and has_function_privilege('${API}', p.oid, 'EXECUTE')
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`)).toBe(0);
    expect(await count(`select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_care_messaging_qualification' and has_function_privilege('${API}', p.oid, 'EXECUTE')`)).toBe(4);
    // The global role reaches hundreds (295 at the 112 release); this one reaches four.
    expect(await count(`select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname like 'clinical\\_%' and has_schema_privilege('clinical_core_api', n.oid, 'USAGE')
        and has_function_privilege('clinical_core_api', p.oid, 'EXECUTE')`)).toBeGreaterThan(250);
    expect(await count(`select count(*)::integer as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname like 'clinical\\_%' and c.relkind in ('r','p','v','m') and has_table_privilege('${API}', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`)).toBe(0);
    expect(await count(`select count(*)::integer as n from pg_database d where d.datname <> current_database()
      and d.datallowconn and has_database_privilege('${LOGIN}', d.oid, 'CONNECT') and not d.datistemplate`)).toBe(0);
  });

  // Each family the global role can reach: clinic membership, programs, privacy, operator, sibling services, and the
  // messaging targets themselves without their proxy.
  const UNRELATED = [
    ['clinic', 'clinical_core.add_org_member(uuid,text,text)'], ['clinic', 'clinical_core.set_org_member_role(uuid,text)'],
    ['clinic', 'clinical_core.remove_org_member(uuid)'], ['clinic', 'clinical_core.activate_my_memberships()'],
    ['clinic', 'clinical_core.list_my_organizations()'], ['clinic', 'clinical_core.issue_connection_invitation(uuid,uuid,text,timestamp with time zone,text)'],
    ['program', 'clinical_core.invoke_program_operation(text,jsonb)'],
    ['privacy', 'clinical_core.request_owned_privacy_export_job(uuid,text)'], ['privacy', 'clinical_core.list_owned_privacy_requests()'],
    ['operator', 'clinical_private.reconcile_privacy_export_by_operator(uuid,uuid,bigint,boolean)'],
    ['operator', 'clinical_private.list_privacy_export_cleanup_for_operator(integer)'],
    ['operator', 'clinical_private.bootstrap_self_service_consumer(uuid,uuid,text)'],
    ['billing', 'clinical_core.invoke_billing_operation(text,jsonb)'],
    ['sibling service', 'clinical_core.production_care_connection_request(jsonb)'], ['sibling service', 'clinical_core.production_care_claim_request(jsonb)'],
    ['sibling service', 'clinical_core.production_telehealth_consent_request(jsonb)'],
    ['target without proxy', 'clinical_core.production_care_message_request(jsonb)'],
    ['target without proxy', 'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)'],
  ] as const;
  it.each(UNRELATED)('%s: %s is refused to the care-messaging role', async (_family, signature) => {
    // The function exists, so a refusal is the role's, not a typo's.
    const found = await db.query<{ oid: number | null; args: number }>(`select to_regprocedure($1)::oid as oid,
      (select pronargs from pg_proc where oid = to_regprocedure($1)) as args`, [signature]);
    expect(found.rows[0]!.oid, signature).not.toBeNull();
    const name = signature.slice(0, signature.indexOf('('));
    const call = `select ${name}(${Array.from({ length: Number(found.rows[0]!.args) }, () => 'null').join(',')})`;
    await db.exec(`set session authorization ${LOGIN}`);
    try {
      await db.exec(`set role ${API}`);
      await expect(db.query(call)).rejects.toThrow(/permission denied/);
    } finally { await db.exec('reset role'); await db.exec('set session authorization postgres'); }
  });
});

describe('applied: the same messaging journey runs through the proxies, with its own checks', () => {
  let org: string, owner: string, other: string, staff: string, patient: string, connection: string, artifact: string;
  const subject = (person: string) => 'subject-' + person;
  const now = Date.now(), review = '2'.repeat(64);
  const SECRET = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-AbCd12';
  const environment = (over: Record<string, string> = {}) => ({ SOURCE_COMMIT: build.sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256,
    AWS_REGION: 'us-east-2', DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked',
    CARE_MESSAGING_DATABASE_CREDENTIAL: 'restricted_qualification',
    CONSUMER_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer', CONSUMER_AUDIENCE: 'c'.repeat(26),
    WORKFORCE_ISSUER: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', WORKFORCE_AUDIENCE: 'w'.repeat(26),
    CARE_MESSAGING_ORGANIZATION_ID: org, CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    CLINICAL_DATABASE_SECRET_ARN: SECRET, CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    DATABASE_REVIEW_SHA256: review, WORKFORCE_MFA_REVIEW_SHA256: review, MESSAGING_REVIEW_SHA256: review, RETENTION_REVIEW_SHA256: review,
    QUALIFICATION_EXECUTION: 'enabled', QUALIFICATION_REVIEW_SHA256: review, QUALIFICATION_ACCOUNT_ID: '588966314750',
    QUALIFICATION_IDENTITY_SUBJECTS: [owner, other, staff].map(subject).join(','), ...over });
  const request = (body: unknown, who: string, pool: 'consumer' | 'workforce' = 'consumer', privacy = false): ApiGatewayV2Event => {
    const issuer = pool === 'consumer' ? 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer' : 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce';
    return { routeKey: `POST /clinical-core/${pool}/messages${privacy ? '/export' : ''}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      requestContext: { authorizer: { jwt: { claims: { iss: issuer, aud: (pool === 'consumer' ? 'c' : 'w').repeat(26), sub: subject(who),
        'custom:person_id': who, 'custom:organization_id': org, 'custom:production_bound': 'true', email_verified: 'true', token_use: 'id',
        iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + 1000, auth_time: Math.floor(now / 1000) - 10 } } } } } as ApiGatewayV2Event;
  };
  const send = () => ({ action: 'send' as const, requestId: randomUUID(), connectionId: connection,
    subject: 'Fictional question', body: 'FICTIONAL patient message', acknowledgement: 'care-messages/1' as const });

  beforeAll(async () => {
    [org, owner, other, staff, patient, connection, artifact] = Array.from({ length: 7 }, () => randomUUID());
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL')", [org]);
    for (const [id, pool] of [[owner, 'consumer'], [other, 'consumer'], [staff, 'workforce']] as const) {
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

  it('send, recipient refusal, clinician read, consent withdrawal and the retained export, as the restricted role', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const sent = await handler(request(send(), owner));
    expect(sent).toMatchObject({ statusCode: 200, headers: { 'x-clinical-execution': 'qualification' } });
    const threadId = JSON.parse(sent.body).data.threadId;
    // Another patient is not a recipient; the practitioner of the clinic is.
    expect(await handler(request({ action: 'read', threadId }, other))).toMatchObject({ statusCode: 403 });
    expect(await handler(request({ action: 'read', threadId }, staff, 'workforce'))).toMatchObject({ statusCode: 200 });
    await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,scope,status,method,
      representative_authority,reason_code,version,recorded_by_person_id) values($1,$2,$3,'messaging','revoked','patient_app','self','patient_request',2,$4)`, [org, patient, connection, owner]);
    expect(await handler(request({ action: 'read', threadId }, owner))).toMatchObject({ statusCode: 403 });
    const exported = await handler(request({ action: 'export', section: 'messages' }, owner, 'consumer', true));
    expect(exported.statusCode).toBe(200);
    expect(JSON.parse(exported.body).data.records.map((r: { body: string }) => r.body)).toEqual(['FICTIONAL patient message']);
  });

  it('drift in the grants or a proxy body stops the service before any business SQL', async () => {
    const handler = createRestrictedCareMessagingHandler(environment(), build, () => restricted, () => now);
    const drifts = [
      [`grant usage on schema clinical_core to ${API}`, `revoke usage on schema clinical_core from ${API}`],
      [`grant execute on function clinical_core.production_care_message_request(jsonb) to ${API}`, `revoke execute on function clinical_core.production_care_message_request(jsonb) from ${API}`],
      [`grant clinical_core_api to ${LOGIN}`, `revoke clinical_core_api from ${LOGIN}`],
      ['alter function clinical_care_messaging_qualification.export(jsonb) set search_path = public', "alter function clinical_care_messaging_qualification.export(jsonb) set search_path = ''"],
      ['create function clinical_care_messaging_qualification.unreviewed() returns integer language sql as $$ select 1 $$', 'drop function clinical_care_messaging_qualification.unreviewed()'],
    ];
    for (const [change, restore] of drifts) {
      await db.exec(change!);
      try { expect(await handler(request({ action: 'read', threadId: randomUUID() }, owner)), change).toMatchObject({ statusCode: 503 }); }
      finally { await db.exec(restore!); }
    }
    expect(await handler(request(send(), owner))).toMatchObject({ statusCode: 403 }); // consent is still withdrawn: a refusal, not an outage
  });

  it('a statement outside the service\'s own four is refused before it is sent', async () => {
    const sent: string[] = [];
    const spy: ClinicalCoreDatabase = { transaction: work => restricted.transaction(tx => work({ query: (sql, args) => { sent.push(sql); return tx.query(sql, args); } })) };
    const guarded = bindRestrictedCareMessagingDatabase(spy, build);
    await expect(guarded.transaction(tx => tx.query('select clinical_core.list_my_organizations()'))).rejects.toThrow('service_unavailable');
    await expect(guarded.transaction(tx => tx.query('select clinical_private.set_current_workforce_context($1,$2,$3,$4)'))).rejects.toThrow('service_unavailable');
    expect(sent).toHaveLength(2);
    expect(sent.every(sql => sql.startsWith('with expected as ('))).toBe(true);
  });

  it("a sibling clinic's practitioner or patient, a token naming the sibling, a removed member and a closed clinic are refused through the proxies", async () => {
    const [sibling, siblingStaff, siblingOwner, siblingPatient, siblingConnection] = Array.from({ length: 5 }, () => randomUUID());
    // The sibling subjects are designated too, so each refusal below comes from the database's own checks through the
    // proxies, not from the qualification boundary turning an undesignated subject away first.
    const handler = createRestrictedCareMessagingHandler(environment({ QUALIFICATION_IDENTITY_SUBJECTS:
      [owner, other, staff, siblingStaff, siblingOwner].map(subject).join(',') }), build, () => restricted, () => now);
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL sibling')", [sibling]);
    for (const [id, pool] of [[siblingStaff, 'workforce'], [siblingOwner, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id)]);
    }
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [sibling, siblingStaff]);
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Sibling')", [siblingPatient, sibling, 'patient_sibling_' + siblingPatient.replaceAll('-', '')]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',now())", [siblingConnection, sibling, siblingPatient, siblingOwner]);
    // The clinic's own patient consents again, so the clinic's practitioner can read; every refusal below is then the
    // caller's, not the consent's.
    await db.query(`insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,
      representative_authority,version,recorded_by_person_id) values($1,$2,$3,$4,'messaging','granted','patient_app','self',3,$5)`, [org, patient, connection, artifact, owner]);
    const sent = await handler(request(send(), owner));
    expect(sent.statusCode).toBe(200);
    const threadId = JSON.parse(sent.body).data.threadId;
    const readThread = (who: string, pool: 'consumer' | 'workforce' = 'workforce', claimed = org) => {
      const event = request({ action: 'read', threadId }, who, pool);
      (event.requestContext as { authorizer: { jwt: { claims: Record<string, unknown> } } }).authorizer.jwt.claims['custom:organization_id'] = claimed;
      return handler(event);
    };
    expect(await readThread(staff)).toMatchObject({ statusCode: 200 });
    const thread = (await readThread(staff)).body;
    // A sibling clinic's practitioner and patient. The database refuses the practitioner whose token names this clinic
    // (no membership here) and the patient whatever clinic the token names (a patient is bound by connection rows, and
    // there is none here). A workforce token naming the sibling clinic is refused before any SQL by the service, which
    // serves exactly one clinic; so is this clinic's own practitioner holding such a token.
    for (const [who, pool, claimed, status] of [[siblingStaff, 'workforce', org, 403], [siblingOwner, 'consumer', org, 403],
      [siblingOwner, 'consumer', sibling, 403], [siblingStaff, 'workforce', sibling, 401], [staff, 'workforce', sibling, 401]] as const) {
      const answer = await readThread(who, pool, claimed);
      expect(answer.statusCode, `${pool} ${who === staff ? 'own practitioner' : 'sibling'} naming ${claimed === org ? 'this clinic' : 'the sibling'}`).toBe(status);
      expect(answer.body).not.toContain('FICTIONAL');
    }
    // A removed membership, on the next request with the same token.
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [org, staff]);
    expect(await readThread(staff)).toMatchObject({ statusCode: 403 });
    await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2", [org, staff]);
    expect((await readThread(staff)).body).toBe(thread);
    // A closed clinic: refused by messaging's own actor check, and again by the clinic-status successor once applied.
    // The patient's retained export (consumer pool) keeps working either way.
    const successor = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql');
    const rollback = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql');
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [org]);
    try {
      for (const applied of [false, true]) {
        if (applied) await db.exec(successor);
        expect(await readThread(staff), `successor ${applied}`).toMatchObject({ statusCode: 403 });
        expect((await handler(request({ action: 'export', section: 'messages' }, owner, 'consumer', true))).statusCode, `successor ${applied}`).toBe(200);
      }
    } finally {
      await db.exec(rollback);
      await db.query("update clinical_core.organizations set status='active' where id=$1", [org]);
    }
    expect((await readThread(staff)).body).toBe(thread);
  });
});

describe('the configuration is refused before any database client exists', () => {
  const base = () => ({ SOURCE_COMMIT: build.sourceCommit, MIGRATION_RELEASE_SHA256: build.migrationReleaseSha256, AWS_REGION: 'us-east-2',
    DEPLOYMENT_ACCOUNT_ID: '588966314750', PHI_ALLOWED: 'false', CARE_MESSAGING_ACTIVATION: 'blocked', CARE_MESSAGING_DATABASE_CREDENTIAL: 'restricted_qualification',
    CLINICAL_DATABASE_CLUSTER_ARN: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional', CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-AbCd12' });
  it.each([
    ['the RDS-managed cluster-master secret', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-0a1b2c3d-AbCd12' }],
    ['the program API\'s dedicated secret', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-AbCd12' }],
    ['a secret in another account', { CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:173535830222:secret:alp-qualification-care-messaging-api-db-AbCd12' }],
    ['no secret', { CLINICAL_DATABASE_SECRET_ARN: '' }],
    ['another database', { CLINICAL_DATABASE_NAME: 'clinical_core' }],
    ['the production account', { DEPLOYMENT_ACCOUNT_ID: '173535830222' }],
    ['PHI on', { PHI_ALLOWED: 'true' }],
    ['activation approved', { CARE_MESSAGING_ACTIVATION: 'approved' }],
    ['database_current (its setter has no reviewed proxy)', { CARE_MESSAGING_WORKFORCE_AUTHORITY: 'database_current' }],
    ['the credential mode unset', { CARE_MESSAGING_DATABASE_CREDENTIAL: '' }],
  ])('%s', async (_label, over) => {
    const factory = vi.fn(() => restricted);
    const handler = createRestrictedCareMessagingHandler({ ...base(), ...over }, build, factory, () => Date.now());
    expect(await handler({ routeKey: 'POST /clinical-core/consumer/messages', headers: {}, body: '{}', requestContext: {} } as ApiGatewayV2Event))
      .toMatchObject({ statusCode: 503, body: JSON.stringify({ error: 'service_unavailable' }) });
    expect(factory).not.toHaveBeenCalled();
  });
  it('the 106 release, which has no qualification successor for this credential', async () => {
    const factory = vi.fn(() => restricted);
    const handler = createRestrictedCareMessagingHandler(base(), { ...build, migrationCount: 106, migrationReleaseSha256: '514959bf0d32de55ded312509ae2ebe39a0fdde9f59246b096b0c41ba63f4f9b' }, factory);
    expect(await handler({ routeKey: 'POST /clinical-core/consumer/messages', headers: {}, body: '{}', requestContext: {} } as ApiGatewayV2Event)).toMatchObject({ statusCode: 503 });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('the rollback preserves everything it did not create', () => {
  it('refuses another database, an enabled login, an extra grant or an extra object; then removes only its own', async () => {
    const before = await count('select count(*)::integer as n from clinical_core.messages');
    expect(before).toBeGreaterThan(0);
    await expect(db.exec(ROLLBACK_SQL)).rejects.toThrow(/qualification_database_refused/);
    const guarded = [
      [`alter role ${LOGIN} login`, `alter role ${LOGIN} nologin`, /qualification_roles_not_rollback_safe/],
      [`grant select on clinical_core.messages to ${API}`, `revoke select on clinical_core.messages from ${API}`, /qualification_grants_not_rollback_safe/],
      ['create function clinical_care_messaging_qualification.unreviewed() returns integer language sql as $$ select 1 $$', 'drop function clinical_care_messaging_qualification.unreviewed()', /qualification_proxy_not_rollback_safe/],
      [`grant clinical_core_api to ${API}`, `revoke clinical_core_api from ${API}`, /qualification_membership_not_rollback_safe/],
    ] as const;
    for (const [change, restore, reason] of guarded) {
      await db.exec(change);
      try { await expect(db.exec(scoped(ROLLBACK_SQL)), change).rejects.toThrow(reason); }
      finally { await db.exec(restore); }
      expect(await rolesLeft()).toBe(2);
    }
    await db.exec(scoped(ROLLBACK_SQL));
    expect(await rolesLeft()).toBe(0);
    expect(await schemaLeft()).toBe(0);
    expect(await count('select count(*)::integer as n from clinical_core.messages')).toBe(before);
    expect(await count(`select count(*)::integer as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'clinical_core' and p.proname like 'production_care_message_%'`)).toBe(3);
    await expect(db.exec(scoped(ROLLBACK_SQL))).rejects.toThrow(/qualification_roles_not_rollback_safe/);
  });
});

void ClinicalCoreDatabaseRejection;
