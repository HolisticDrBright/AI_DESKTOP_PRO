import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * Ordinary clinic suspension versus emergency login revocation, stage by stage, on the real 106-migration schema. The
 * owner's policy: an ordinary suspension MAY leave an already-valid practitioner session usable until it expires, a
 * refresh must not extend it, new practitioner consent grants are blocked while withdrawals remain available, and a suspected compromise is a different
 * event, revoked at once.
 *
 * The stages are every combination of BLOCKED candidates that can exist: as deployed; the clinic-status successor
 * (which the owner ruled out, because it ends every existing session); that plus the consent-decision successor; the
 * emergency revocation; and that plus the consent-decision successor. The clinic-status successor and the revocation
 * refuse each other as parents, so no stage holds both.
 *
 * The finding this file pins: in NO stage can the database tell a session that existed before the suspension from a
 * sign-in or refresh after it. Every legacy request reaches set_request_context with the same seven values (person,
 * clinic, pool, subject, purpose, environment, classification), none of them a time, and an ordinary clinic records no
 * time it was suspended. So "until its expiry" and "a refresh must not extend it" cannot be enforced from current
 * authority data, and no continuity successor is built (docs/clinic-continuity-emergency-revocation-2026-10-16.md §4).
 * These five stages still have no such contract. The BLOCKED workforce-ordinary-suspension-window.sql (17 October) adds it
 * on the emergency revocation, and ordinary-suspension-window.database.test.ts tests it; it is not one of these stages.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const STATUS = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql';
const DECISION = 'infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql';
const REVOCATION = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql';
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
type Stage = { name: string; files: string[]; status: boolean; decision: boolean; revocation: boolean };
const STAGES: Stage[] = [
  { name: 'as deployed', files: [], status: false, decision: false, revocation: false },
  { name: 'clinic-status successor (ruled out by the owner)', files: [STATUS], status: true, decision: false, revocation: false },
  { name: 'clinic-status and consent-decision successors', files: [STATUS, DECISION], status: true, decision: true, revocation: false },
  { name: 'emergency revocation', files: [...CHAIN, REVOCATION], status: false, decision: false, revocation: true },
  { name: 'emergency revocation and consent-decision successor', files: [...CHAIN, REVOCATION, DECISION], status: false, decision: true, revocation: true },
];
type Purpose = 'clinical_data' | 'consent_management' | 'identity_link';
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
});

describe.each(STAGES)('$name', stage => {
  let db: PGlite;
  let clinic: string, practitioner: string, consumer: string, service: string, operator: string, reviewer: string;
  let patient: string, connection: string, artifact: string;
  const platformOperator = randomUUID();
  const subject = (person: string, pool = 'workforce') => `subject-${pool}-${person}`;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
    for (const file of stage.files) for (const statement of splitPostgresStatements(read(file))) await db.exec(statement);
    if (stage.revocation) {
      await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1)', [platformOperator]);
      await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after'");
    }
  }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    [clinic, practitioner, consumer, service, operator, reviewer, patient, connection, artifact] = Array.from({ length: 9 }, () => randomUUID());
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic')", [clinic]);
    for (const [id, pool] of [[practitioner, 'workforce'], [service, 'workforce'], [operator, 'workforce'], [reviewer, 'workforce'], [consumer, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner'),($1,$3,'staff')", [clinic, practitioner, operator]);
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [patient, clinic, 'patient_' + patient.replaceAll('-', '')]);
    await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
      [connection, clinic, patient, consumer]);
    await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values($1,$2,'forms_checkins',$3,$4,'US-FICTIONAL','approved',clock_timestamp(),$5)`, [artifact, clinic, `fictional-${artifact.slice(0, 8)}`, 'c'.repeat(64), reviewer]);
  });

  /** One legacy request: the seven values a service passes, nothing else. A token's issue and expiry times are not among them. */
  async function as(who: string, purpose: Purpose, sql: string, args: unknown[] = [], pool: 'workforce' | 'consumer' = 'workforce') {
    return db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [who, clinic, pool, subject(who, pool), purpose]);
      return (await tx.query(sql, args)).rows;
    });
  }
  const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    return `refused:${classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category ?? 'unclassified'}:${text.split(/\s/)[0]}`;
  });
  const readPatient = () => as(practitioner, 'clinical_data', 'select id from clinical_core.patient_records where id=$1', [patient]).then(rows => {
    if (rows.length !== 1) throw new Error('patient_not_visible');
    return rows;
  });
  const writePatient = () => as(practitioner, 'clinical_data', "select clinical_core.create_patient_profile($1,'Fictional','Patient') as id", [clinic]);
  const grant = (who = practitioner, pool: 'workforce' | 'consumer' = 'workforce') => as(who, 'consent_management',
    "select consent_id from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')", [connection, artifact], pool);
  const withdraw = (who = practitioner, pool: 'workforce' | 'consumer' = 'workforce') => as(who, 'consent_management',
    "select consent_id from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')", [connection], pool);
  const suspend = () => db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinic]);
  const CLOSED = 'refused:identity_refused:request_context_refused';
  const DECISION_CLOSED = 'refused:identity_refused:consent_actor_refused';

  it('an existing session before an ordinary suspension, and a sign-in or refresh after it, reach the database as the same call', async () => {
    await expect(readPatient()).resolves.toHaveLength(1);
    await suspend();
    // The session that existed before the suspension.
    const existing = [await outcome(readPatient()), await outcome(writePatient())];
    // A refresh (or a new sign-in whose token still names the clinic): the service passes exactly the same seven values.
    const refreshed = [await outcome(readPatient()), await outcome(writePatient())];
    expect(refreshed).toEqual(existing);
    expect(existing).toEqual(stage.status ? [CLOSED, CLOSED] : ['admitted', 'admitted']);
    // So either both continue (no expiry bound, and a refresh extends it) or both end (every existing session ends).
    // The owner's rule needs the first to continue and the second to end; no stage can say which is which.
  });

  it('MISSING CONTRACT: the entry takes no token time, and an ordinary clinic records no time it was suspended', async () => {
    const entry = (await db.query<{ args: string }>("select pg_get_function_identity_arguments(to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')) as args")).rows[0]!.args;
    expect(entry).toBe('_actor_person_id uuid, _organization_id uuid, _identity_pool text, _identity_subject text, _purpose text, _environment text, _data_classification text');
    const overloads = (await db.query<{ n: number }>("select count(*)::int as n from pg_proc where proname='set_request_context' and pronamespace='clinical_private'::regnamespace")).rows[0]!.n;
    expect(overloads).toBe(1);
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='clinical_core' and table_name='organizations'")).rows
      .map(row => row.column_name);
    expect(columns.filter(column => /suspend|status_changed|closed_at|archived_at/.test(column))).toEqual([]);
    const ledgers = (await db.query<{ t: string }>(`select table_schema||'.'||table_name as t from information_schema.columns
      where column_name='organization_id' and table_name ~ 'organization_status|clinic_status' group by 1`)).rows;
    expect(ledgers).toEqual([]);
  });

  it(`a suspected compromised identity: ${stage.revocation ? 'one operator decision refuses the next request' : 'no writer exists; only a direct table-owner update would refuse it'}`, async () => {
    await expect(readPatient()).resolves.toHaveLength(1);
    if (stage.revocation) {
      await db.transaction(async tx => {
        await tx.exec('set local role clinical_workforce_operator');
        await tx.query("select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise')", [platformOperator, randomUUID(), subject(practitioner)]);
      });
    } else {
      const writer = (await db.query<{ n: number }>("select count(*)::int as n from pg_proc where proname ~ 'revoc|disable' and prosrc ~* 'update\\s+clinical_core\\.identities' and prosrc !~ 'consumer'")).rows[0]!.n;
      expect(writer).toBe(0);
      await db.query("update clinical_core.identities set status='disabled' where person_id=$1 and identity_pool='workforce'", [practitioner]);
    }
    expect(await outcome(readPatient())).toBe(CLOSED);
    expect(await outcome(grant())).toBe(CLOSED);
    // The clinic was never touched.
    expect((await db.query<{ status: string }>('select status from clinical_core.organizations where id=$1', [clinic])).rows[0]!.status).toBe('active');
  });

  it('the patient\'s own grant and withdrawal run in a suspended clinic in every stage', async () => {
    await suspend();
    await expect(grant(consumer, 'consumer')).resolves.toHaveLength(1);
    await expect(withdraw(consumer, 'consumer')).resolves.toHaveLength(1);
  });

  it(`a practitioner-recorded new grant and withdrawal in a suspended clinic: ${stage.decision ? 'new grant refused, withdrawal allowed (D2)' : 'both admitted'}`, async () => {
    await suspend();
    expect(await outcome(grant())).toBe(stage.decision ? DECISION_CLOSED : 'admitted');
    if (!stage.decision) {
      expect(await outcome(withdraw())).toBe('admitted');
    } else {
      await db.query("update clinical_core.organizations set status='active' where id=$1", [clinic]);
      await grant();
      await suspend();
      expect(await outcome(withdraw())).toBe('admitted');
    }
  });

  it('retention runs in a suspended clinic; recording cleanup and placing a legal hold are refused there (D3, D4) in every stage', async () => {
    await db.query(`insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
      values($1,$2,$3,repeat('a',64),$4,clock_timestamp()-interval '1 hour')`, [`fictional-${service}`, service, subject(service), reviewer]);
    await db.query(`insert into clinical_private.recording_cleanup_operators(organization_id,operator_id,reviewed_by,evidence_sha256,approved_at,expires_at)
      values($1,$2,$3,repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`, [clinic, operator, reviewer]);
    await suspend();
    await expect(as(service, 'consent_management', 'select clinical_private.list_privacy_export_cleanup_for_retention(25) as items')).resolves.toEqual([{ items: [] }]);
    expect(await outcome(as(operator, 'consent_management', 'select clinical_private.list_recording_cleanup_work(null,25) as work'))).toMatch(/recording_cleanup_operator_required/);
    expect(await outcome(as(operator, 'consent_management', "select clinical_private.place_recording_legal_hold($1,'litigation') as id", [patient])))
      .toMatch(/recording_cleanup_operator_required/);
  });
});
