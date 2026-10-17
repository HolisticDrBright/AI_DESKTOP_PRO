import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import { WORKFORCE_CONSENT_GRANT_PATHS } from './workforce-consent-grant-paths';

/**
 * Withdrawals-only in a suspended clinic, as a property of every workforce consent path, not only of the two functions
 * the consent-decision candidate gates. Fictional rows only, on the real 106-migration schema.
 *
 * Every SQL function the API role can call that writes a consent table (pinned below against the schema):
 *   record_consent_grant / revoke_consent_grant      the consent-decision candidate (grant gated, withdrawal open);
 *   set_sync_consent_scope (grant and withdrawal)    workforce, a production Desktop RPC on the pilot allow-list;
 *   revoke_sync_connection                           workforce withdrawal of a whole connection;
 *   grant_ / withdraw_encounter_recording_consent    workforce recording consent;
 *   production_care_connection_request               consumer (the patient's own), out of this rule;
 *   set_owned_consumer_consent                       consumer storage consent, out of this rule.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SOURCE = 'infra/aws-clinical-core/source-candidates/';
const DECISION = `${SOURCE}workforce-consent-decision-clinic-status.sql`;
const GRANT_PATHS = `${SOURCE}workforce-consent-grant-paths-clinic-status.sql`;
const GRANT_PATHS_ROLLBACK = `${SOURCE}workforce-consent-grant-paths-clinic-status-rollback.sql`;
const CHAIN = [
  `${SOURCE}workforce-token-binding-lookup.sql`, `${SOURCE}workforce-clinic-approved-onboarding.sql`,
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql', `${SOURCE}workforce-join-review-uniform-refusal.sql`,
  `${SOURCE}workforce-current-membership-context.sql`, `${SOURCE}workforce-onboarding-approval-authority.sql`,
  `${SOURCE}workforce-identity-emergency-revocation.sql`, `${SOURCE}workforce-ordinary-suspension-window.sql`,
];
const SYNC = 'clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text)';
const RECORDING = 'clinical_private.grant_encounter_recording_consent(uuid,uuid,uuid,text,text,uuid)';

let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function apply(db: PGlite, file: string) {
  try { for (const statement of splitPostgresStatements(read(file))) await db.exec(statement); } catch (error) {
    await db.exec('rollback').catch(() => undefined);
    throw error;
  }
}
async function build(files: string[]) {
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of files) await apply(db, file);
  return db;
}
const prosrc = async (db: PGlite, signature: string) =>
  (await db.query<{ h: string | null }>(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid=to_regprocedure($1)`, [signature])).rows[0]?.h ?? null;
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  const category = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category;
  return `refused:${category ?? 'unclassified'}:${(text.match(/\b[a-z_]+_(?:refused|required|held|not_found|first)\b/) ?? [text])[0]}`;
});
const ACTOR = 'refused:identity_refused:consent_actor_refused';

function harness(db: () => PGlite) {
  const ids = { clinic: '', other: '', practitioner: '', colleague: '', outsider: '', staff: '', consumer: '', reviewer: '', patient: '', connection: '', artifact: '' };
  const subject = (person: string, pool = 'workforce') => `subject-${pool}-${person}`;
  const ARTIFACT = { title: 'FICTIONAL sync consent', version: '' };
  const setup = async () => {
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = randomUUID();
    ARTIFACT.version = `fictional-${ids.artifact.slice(0, 8)}`;
    await db().query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic'),($2,'FICTIONAL other clinic')", [ids.clinic, ids.other]);
    for (const [id, pool] of [[ids.practitioner, 'workforce'], [ids.colleague, 'workforce'], [ids.outsider, 'workforce'], [ids.staff, 'workforce'],
      [ids.reviewer, 'workforce'], [ids.consumer, 'consumer']] as const) {
      await db().query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db().query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    await db().query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ($1,$3,'practitioner'),($1,$4,'practitioner'),($2,$5,'practitioner'),($1,$6,'staff')`, [ids.clinic, ids.other, ids.practitioner, ids.colleague, ids.outsider, ids.staff]);
    await db().query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [ids.patient, ids.clinic, 'patient_' + ids.patient.replaceAll('-', '')]);
    await db().query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
      [ids.connection, ids.clinic, ids.patient, ids.consumer]);
    await db().query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_title,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'forms_checkins',$3,$4,$5,'US-FICTIONAL','approved',clock_timestamp(),$6)`, [ids.artifact, ids.clinic, ARTIFACT.title, ARTIFACT.version, 'c'.repeat(64), ids.reviewer]);
  };
  const as = (who: string, purpose: string, sql: string, args: unknown[] = [], pool = 'workforce', clinic = ids.clinic) => db().transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [who, clinic, pool, subject(who, pool), purpose]);
    return (await tx.query<{ result: unknown }>(sql, args)).rows[0]?.result;
  });
  const syncScope = (grant: boolean, who = ids.practitioner, clinic = ids.clinic) => as(who, 'clinical_data',
    "select clinical_core.set_sync_consent_scope($1,'forms_checkins',$2,$3,$4,'US-FICTIONAL','in_person','self') as result",
    [ids.connection, grant, ARTIFACT.title, ARTIFACT.version], 'workforce', clinic);
  const decisionGrant = (who = ids.practitioner) => as(who, 'consent_management',
    "select consent_id as result from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')", [ids.connection, ids.artifact]);
  const decisionWithdraw = (who = ids.practitioner, pool = 'workforce') => as(who, 'consent_management',
    "select consent_id as result from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')", [ids.connection], pool);
  const live = async () => (await db().query<{ status: string }>(`select status from clinical_core.consent_grants where connection_id=$1 and scope='forms_checkins'
    order by version desc limit 1`, [ids.connection])).rows[0]?.status ?? null;
  // Recording consent: an in-progress encounter, a participant, an approved consent release.
  const encounter = async (who = ids.practitioner) => (await as(who, 'clinical_data', 'select clinical_core.start_encounter($1,$2) as result', [ids.clinic, ids.patient])) as string;
  const participant = async (e: string) => (await as(ids.practitioner, 'clinical_data',
    "select clinical_private.add_encounter_recording_participant($1,'patient','FICTIONAL PARTICIPANT',true,$2) as result", [e, randomUUID()])) as string;
  const release = async () => {
    const id = randomUUID();
    await db().query(`insert into clinical_private.recording_consent_releases(id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
      values($1::uuid,$2,'ai_drafting',($1::uuid)::text,'en','FICTIONAL','FICTIONAL CONSENT ONLY',encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex'),'FICTIONAL TEST REVIEW',clock_timestamp()-interval '1 day')`,
      [id, ids.clinic]);
    return id;
  };
  const recordingGrant = (p: string, r: string, command = randomUUID()) => as(ids.practitioner, 'clinical_data',
    "select clinical_private.grant_encounter_recording_consent($1,$2,$3,'written','FICTIONAL ACK',null) as result", [p, r, command]);
  const recordingWithdraw = (grantId: string) => as(ids.practitioner, 'clinical_data',
    "select clinical_private.withdraw_encounter_recording_consent($1,'FICTIONAL WITHDRAWAL') as result", [grantId]);
  const status = (value: string) => db().query('update clinical_core.organizations set status=$2 where id=$1', [ids.clinic, value]);
  return { ids, subject, setup, as, syncScope, decisionGrant, decisionWithdraw, live, encounter, participant, release, recordingGrant, recordingWithdraw, status };
}

describe('with the consent-decision candidate alone: failing before', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build([DECISION]); }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('record_consent_grant is refused in a suspended clinic, but the sync screen records a new grant there', async () => {
    await h.status('suspended');
    expect(await outcome(h.decisionGrant())).toBe(ACTOR);
    expect(await outcome(h.syncScope(true))).toBe('admitted');
    expect(await h.live()).toBe('granted');
  });

  it('and a new recording consent is granted in a suspended clinic', async () => {
    const e = await h.encounter(), p = await h.participant(e), r = await h.release();
    await h.status('suspended');
    expect(await outcome(h.recordingGrant(p, r))).toBe('admitted');
  });
});

describe('with the grant-paths successor on the consent-decision candidate', () => {
  let db: PGlite;
  const h = harness(() => db);
  beforeAll(async () => { db = await build([DECISION, GRANT_PATHS]); }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(() => h.setup());

  it('is pinned: file digests, both successor bodies, its parents', async () => {
    expect(sha(read(GRANT_PATHS))).toBe(WORKFORCE_CONSENT_GRANT_PATHS.sha256);
    expect(sha(read(GRANT_PATHS_ROLLBACK))).toBe(WORKFORCE_CONSENT_GRANT_PATHS.rollbackSha256);
    expect(await prosrc(db, SYNC)).toBe(WORKFORCE_CONSENT_GRANT_PATHS.prosrc.sync);
    expect(await prosrc(db, RECORDING)).toBe(WORKFORCE_CONSENT_GRANT_PATHS.prosrc.recording);
    for (const parent of Object.values(WORKFORCE_CONSENT_GRANT_PATHS.parents)) expect(read(GRANT_PATHS)).toContain(parent);
  });

  it('every API-callable function that writes a consent table is one this file or the consent-decision candidate accounts for', async () => {
    const rows = (await db.query<{ f: string }>(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname like 'clinical%' and p.prosrc ~* '(insert\\s+into|update)\\s+clinical_[a-z_]+\\.[a-z_]*consent'
        and has_function_privilege('clinical_core_api', p.oid, 'execute') order by 1`)).rows.map(row => row.f);
    expect(rows).toEqual([
      'clinical_core.production_care_connection_request(jsonb)', 'clinical_core.record_consent_grant(uuid,uuid,text,text,text)',
      'clinical_core.revoke_consent_grant(uuid,text,text)', 'clinical_core.revoke_sync_connection(uuid,integer,text)',
      'clinical_core.set_owned_consumer_consent(text,text,text,integer)', SYNC, RECORDING,
      'clinical_private.withdraw_encounter_recording_consent(uuid,text)',
    ]);
  });

  it('a suspended clinic: every new workforce grant is refused at the mutation, and nothing is written', async () => {
    const e = await h.encounter(), p = await h.participant(e), r = await h.release();
    await h.status('suspended');
    expect(await outcome(h.syncScope(true))).toBe(ACTOR);
    expect(await outcome(h.decisionGrant())).toBe(ACTOR);
    expect(await outcome(h.recordingGrant(p, r))).toBe(ACTOR);
    expect(await h.live()).toBeNull();
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_private.recording_consent_grants where participant_id=$1', [p])).rows[0]!.n).toBe(0);
    await h.status('archived');
    expect(await outcome(h.syncScope(true))).toBe(ACTOR);
  });

  it('a suspended clinic: an existing grant can be withdrawn on every withdrawal path, and by the patient', async () => {
    const e = await h.encounter(), p = await h.participant(e), r = await h.release();
    expect(await outcome(h.syncScope(true))).toBe('admitted');
    const recording = await h.recordingGrant(p, r) as string;
    await h.status('suspended');
    expect(await outcome(h.syncScope(false))).toBe('admitted');
    expect(await h.live()).toBe('revoked');
    expect(await outcome(h.recordingWithdraw(recording))).toBe('admitted');
    // A grant made before, withdrawn by the patient after.
    await h.status('active');
    expect(await outcome(h.decisionGrant())).toBe('admitted');
    await h.status('suspended');
    expect(await outcome(h.decisionWithdraw(h.ids.consumer, 'consumer'))).toBe('admitted');
    expect(await h.live()).toBe('revoked');
  });

  it('a revision or superseding grant is a new grant: refused; a retried grant gets its receipt and records nothing new', async () => {
    const e = await h.encounter(), p = await h.participant(e), r = await h.release();
    const command = randomUUID();
    expect(await outcome(h.syncScope(true))).toBe('admitted');
    const first = await h.recordingGrant(p, r, command);
    await h.status('suspended');
    // Revising an active grant requires withdrawing it first; the new grant after that withdrawal is refused.
    expect(await outcome(h.syncScope(false))).toBe('admitted');
    expect(await outcome(h.syncScope(true))).toBe(ACTOR);
    expect(await outcome(h.decisionGrant())).toBe(ACTOR);
    expect(await h.recordingGrant(p, r, command)).toBe(first);
    expect((await db.query<{ n: number }>('select count(*)::int n from clinical_private.recording_consent_grants where participant_id=$1', [p])).rows[0]!.n).toBe(1);
  });

  it('no fabricated withdrawal: nothing to withdraw records nothing; another clinic, a removed member and a staff role cannot withdraw', async () => {
    await h.status('suspended');
    expect(await h.syncScope(false)).toMatchObject({ alreadyApplied: true, status: 'revoked' });
    expect(await h.live()).toBeNull();
    expect(await outcome(h.decisionWithdraw())).not.toBe('admitted');
    await h.status('active');
    expect(await outcome(h.syncScope(true))).toBe('admitted');
    await h.status('suspended');
    expect(await outcome(h.syncScope(false, h.ids.outsider, h.ids.other))).not.toBe('admitted');
    expect(await outcome(h.syncScope(false, h.ids.staff))).toMatch(/clinical_role_required/);
    await db.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [h.ids.colleague]);
    expect(await outcome(h.syncScope(false, h.ids.colleague))).toMatch(/clinical_role_required/);
    expect(await outcome(h.decisionWithdraw(h.ids.colleague))).toBe(ACTOR);
    expect(await h.live()).toBe('granted');
  });

  it('an active clinic is unchanged: every grant path records', async () => {
    const e = await h.encounter(), p = await h.participant(e), r = await h.release();
    expect(await outcome(h.syncScope(true))).toBe('admitted');
    expect(await outcome(h.recordingGrant(p, r))).toBe('admitted');
  });

  it('the rollback restores both parents exactly and keeps every consent row; it refuses twice', async () => {
    const copy = await build([DECISION, GRANT_PATHS]);
    await copy.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL rollback')", [randomUUID()]);
    await apply(copy, GRANT_PATHS_ROLLBACK);
    expect(await prosrc(copy, SYNC)).toBe(WORKFORCE_CONSENT_GRANT_PATHS.parents.sync);
    expect(await prosrc(copy, RECORDING)).toBe(WORKFORCE_CONSENT_GRANT_PATHS.parents.recording);
    expect(message(await apply(copy, GRANT_PATHS_ROLLBACK).catch(error => error))).toMatch(/consent_grant_paths_rollback_refused/);
    await copy.close();
  }, 300_000);
});

describe('guards and the whole chain', () => {
  it('refuses without the consent-decision candidate (its helper is the check), and applies once', async () => {
    const bare = await build([]);
    expect(message(await apply(bare, GRANT_PATHS).catch(error => error))).toMatch(/consent_grant_paths_parent_refused/);
    await bare.close();
    const twice = await build([DECISION, GRANT_PATHS]);
    expect(message(await apply(twice, GRANT_PATHS).catch(error => error))).toMatch(/consent_grant_paths_parent_refused/);
    await twice.close();
  }, 300_000);

  it('with the emergency revocation and the ordinary-suspension window too: a revoked login withdraws nothing; consent management is not windowed', async () => {
    const db = await build([...CHAIN, DECISION, GRANT_PATHS]);
    const h = harness(() => db);
    await h.setup();
    const operator = randomUUID();
    await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1)', [operator]);
    await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after'");
    expect(await outcome(h.decisionGrant())).toBe('admitted');
    await h.status('suspended');
    // Under the window the sync screen is a clinical_data write: with no token evidence it is refused like every unconverted caller.
    expect(await outcome(h.syncScope(false))).toBe('refused:identity_refused:request_context_refused');
    // The withdrawal path the consent-decision candidate keeps open is consent_management, which the window does not touch.
    expect(await outcome(h.decisionWithdraw())).toBe('admitted');
    await h.status('active');
    expect(await outcome(h.decisionGrant())).toBe('admitted');
    await h.status('suspended');
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_workforce_operator');
      await tx.query("select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise')", [operator, randomUUID(), h.subject(h.ids.practitioner)]);
    });
    expect(await outcome(h.decisionWithdraw())).toBe('refused:identity_refused:request_context_refused');
    // A colleague (a lawful practitioner) still can, and the patient can.
    expect(await outcome(h.decisionWithdraw(h.ids.colleague))).toBe('admitted');
    await db.close();
  }, 300_000);
});
