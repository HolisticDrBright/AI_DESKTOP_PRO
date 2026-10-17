import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { classifyDatabaseRejection } from './rds-data-database';

/**
 * Suspended-clinic custody under the deployed default (`legacy_claims`), on the real 106-migration production schema in
 * three stages: as deployed, with the BLOCKED legacy-claims-clinic-status.sql, and with that plus the BLOCKED
 * workforce-consent-decision-clinic-status.sql. Each request runs as its service runs it: set_request_context with the
 * already-issued token's person, clinic and purpose, then the operation, as clinical_core_api. Fictional rows only.
 *
 * WP1, a practitioner session that existed before the suspension: the deployed schema lets it keep reading, writing
 * and deciding consent; the status successor ends its reads and writes but not its consent decisions; with both,
 * nothing it does in the closed clinic is admitted. Records, consent history and audit survive every stage, and the
 * patient's own requests are never refused by either candidate.
 *
 * WP2, consent decisions versus withdrawal cleanup: the status successor admits every workforce consent_management
 * request, because the retention service, privacy operators and recording cleanup share that purpose. The practitioner's
 * own decision is refused only by the second candidate, inside the decision functions, which tell the actors apart.
 * The cleanup cases record what each path actually does in a closed clinic. Recording cleanup is refused by its own
 * deployed operator check, before and after both candidates. That is the finding in
 * docs/suspended-clinic-custody-2026-10-16.md.
 *
 * Lock waits need two sessions, which PGlite cannot give: scripts/qualify-consent-decision-native.mjs runs them.
 */
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const STATUS = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql');
const STATUS_ROLLBACK = read('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql');
const DECISION = read('infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql');
const DECISION_ROLLBACK = read('infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status-rollback.sql');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const GRANT = 'clinical_core.record_consent_grant(uuid,uuid,text,text,text)';
const REVOKE = 'clinical_core.revoke_consent_grant(uuid,text,text)';
const HELPER = 'clinical_private.require_active_consent_clinic(uuid)';
const PARENT = { grant: '75d010fcb9ea0a014d72cc056a8606b071e22ee65bf03eb509b266f7d782bba3', revoke: '0bb066f2d50d473906527ce1dc2dca38b8416e5d5e6c556751b092a2b22be0af' };
const SUCCESSOR = { grant: '89ebfcfc7dbf9cb5443fec121ebac0b4eadde24c6fccc802ec2030ea9c3cf33c', revoke: '002dc02bb8e55e9853a3fffa8ecbc1dd1f900893bce7ee2421530b53627da88f' };

type Stage = 'deployed' | 'status successor' | 'status and consent-decision successors';
const STAGES: Stage[] = ['deployed', 'status successor', 'status and consent-decision successors'];
type Purpose = 'clinical_data' | 'consent_management' | 'identity_link';
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };

beforeAll(() => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  expect(schema.manifest.migrations.some(m => /clinic-status|consent-decision/.test(m.file))).toBe(false);
  // The status successor and its rollback are the reviewed bytes, unchanged by this work.
  expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql', 'utf8'))).toBe('c3788dc20bed9fe6aae40cc939a08a69773d45d56dc297dea21ae99ed6c7cc66');
  expect(sha(readFileSync('infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql', 'utf8'))).toBe('4c311c01148367b82d58e2143c2cce6f21f391fa04d50f1f21e27935224b29a0');
});

describe.each(STAGES)('suspended-clinic custody, legacy claims: %s', stage => {
  const status = stage !== 'deployed', decision = stage === 'status and consent-decision successors';
  let db: PGlite;
  let clinicA: string, clinicB: string, practitioner: string, owner: string, consumer: string, consumerB: string, service: string, operator: string, reviewer: string;
  let patientA: string, patientB: string, connectionA: string, connectionB: string, artifactA: string, artifactB: string;
  const subjects = new Map<string, string>();
  const subject = (person: string, pool = 'workforce') => subjects.get(`${pool}:${person}`) ?? `subject-${pool}-${person}`;

  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
    if (status) await db.exec(STATUS);
    if (decision) await db.exec(DECISION);
  }, 180_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    subjects.clear();
    [clinicA, clinicB, practitioner, owner, consumer, consumerB, service, operator, reviewer] = Array.from({ length: 9 }, () => randomUUID());
    [patientA, patientB, connectionA, connectionB, artifactA, artifactB] = Array.from({ length: 6 }, () => randomUUID());
    await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic A'),($2,'FICTIONAL clinic B')", [clinicA, clinicB]);
    for (const [id, pool] of [[practitioner, 'workforce'], [owner, 'workforce'], [service, 'workforce'], [operator, 'workforce'], [reviewer, 'workforce'],
      [consumer, 'consumer'], [consumerB, 'consumer']] as const) {
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [id, 'subject_' + id.replaceAll('-', '')]);
      await db.query('insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,$2,$3,true)', [id, pool, subject(id, pool)]);
    }
    // The practitioner works in both clinics; the owner administers A; the cleanup operator is a staff member of A.
    await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ($1,$3,'practitioner'),($2,$3,'practitioner'),($1,$4,'owner'),($1,$5,'staff')`, [clinicA, clinicB, practitioner, owner, operator]);
    // One live app connection per patient account, so each clinic's patient is a different fictional person.
    for (const [patient, clinic, connection, artifact, person] of [[patientA, clinicA, connectionA, artifactA, consumer], [patientB, clinicB, connectionB, artifactB, consumerB]]) {
      await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
        [patient, clinic, 'patient_' + patient!.replaceAll('-', '')]);
      await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
        [connection, clinic, patient, person]);
      await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
        values($1,$2,'forms_checkins','fictional-1',$3,'US-FICTIONAL','approved',clock_timestamp(),$4)`, [artifact, clinic, 'c'.repeat(64), owner]);
    }
  });

  /** One request as its service runs it, refused the way the RDS adapter classifies it. */
  async function as<T = unknown>(who: string, clinic: string, purpose: Purpose, sql: string, args: unknown[] = [], pool: 'workforce' | 'consumer' = 'workforce'): Promise<T[]> {
    try {
      return await db.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [who, clinic, pool, subject(who, pool), purpose]);
        return (await tx.query<T>(sql, args)).rows;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { category: classifyDatabaseRejection({ name: 'DatabaseErrorException', message })?.category });
    }
  }
  const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (e: Error & { category?: string }) => `refused:${e.category ?? 'unclassified'}:${e.message}`);
  const readPatient = (who: string, clinic = clinicA, patient = patientA) =>
    as(who, clinic, 'clinical_data', 'select id from clinical_core.patient_records where id=$1', [patient]).then(rows => {
      if (rows.length !== 1) throw new Error('patient_not_visible');
      return rows;
    });
  const writePatient = (who: string, clinic = clinicA) => as(who, clinic, 'clinical_data', "select clinical_core.create_patient_profile($1,'Fictional','Patient') as id", [clinic]);
  const grantAs = (who: string, clinic = clinicA, connection = connectionA, artifact = artifactA, pool: 'workforce' | 'consumer' = 'workforce') => as(who, clinic, 'consent_management',
    "select consent_id from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')", [connection, artifact], pool);
  const revokeAs = (who: string, clinic = clinicA, connection = connectionA, pool: 'workforce' | 'consumer' = 'workforce') => as(who, clinic, 'consent_management',
    "select consent_id from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')", [connection], pool);
  const close = (clinic: string, value: 'suspended' | 'archived' = 'suspended') => db.query('update clinical_core.organizations set status=$2 where id=$1', [clinic, value]);
  const history = async (connection = connectionA) => (await db.query<{ status: string; version: number }>(
    'select status, version from clinical_core.consent_grants where connection_id=$1 order by version', [connection])).rows.map(r => `${r.version}:${r.status}`);
  const custody = async () => (await db.query<{ patients: number; grants: number; audit: number }>(`select
    (select count(*)::int from clinical_core.patient_records where organization_id=$1) as patients,
    (select count(*)::int from clinical_core.consent_grants where organization_id=$1) as grants,
    (select count(*)::int from clinical_audit.events where organization_id=$1) as audit`, [clinicA])).rows[0]!;
  const CLOSED = 'refused:identity_refused:request_context_refused';
  const DECISION_CLOSED = 'refused:identity_refused:consent_actor_refused';

  describe('WP1: a practitioner session that existed before the suspension', () => {
    it('while the clinic is active, the session reads, writes and records a consent decision (control)', async () => {
      await expect(readPatient(practitioner)).resolves.toHaveLength(1);
      await expect(writePatient(practitioner)).resolves.toHaveLength(1);
      await expect(grantAs(practitioner)).resolves.toHaveLength(1);
      expect(await history()).toEqual(['1:granted']);
    });

    it.each(['suspended', 'archived'] as const)(`after a %s commits, the same already-issued session: ${!status ? 'GAP: keeps reading, writing and deciding'
      : !decision ? 'reads and writes refused; GAP: still records new consent grants' : 'reads, writes and new grants refused; withdrawals stay available'}`, async closed => {
      await expect(readPatient(practitioner)).resolves.toHaveLength(1); // the session is live before the change
      await close(clinicA, closed);
      expect(await outcome(readPatient(practitioner))).toBe(status ? CLOSED : 'admitted');
      expect(await outcome(writePatient(practitioner))).toBe(status ? CLOSED : 'admitted');
      expect(await outcome(as(practitioner, clinicA, 'identity_link', 'select 1'))).toBe(status ? CLOSED : 'admitted');
      expect(await outcome(grantAs(practitioner))).toBe(decision ? DECISION_CLOSED : 'admitted');
      expect(await history()).toEqual(decision ? [] : ['1:granted']);
    });

    it('records, consent history and audit survive the suspension unchanged; the candidates delete and rewrite nothing', async () => {
      await grantAs(practitioner);
      await writePatient(practitioner);
      const before = await custody();
      await close(clinicA);
      await outcome(writePatient(practitioner));
      await outcome(revokeAs(practitioner));
      const after = await custody();
      expect(after.patients).toBe(before.patients + (status ? 0 : 1));
      expect(after.grants).toBe(before.grants + 1);
      expect(after.audit).toBeGreaterThanOrEqual(before.audit);
      await db.query("update clinical_core.organizations set status='active' where id=$1", [clinicA]); // a direct write: no reinstatement writer exists
      await expect(readPatient(practitioner)).resolves.toHaveLength(1);
      expect((await history()).at(-1)).toBe('2:revoked');
    });

    it('the patient is never refused by either candidate: their own grant and withdrawal run in the closed clinic', async () => {
      await close(clinicA, 'archived');
      await expect(grantAs(consumer, clinicA, connectionA, artifactA, 'consumer')).resolves.toHaveLength(1);
      await expect(revokeAs(consumer, clinicA, connectionA, 'consumer')).resolves.toHaveLength(1);
      expect(await history()).toEqual(['1:granted', '2:revoked']);
    });

    it('the clinic\'s own owner is refused exactly like any member: the status gate is the clinic\'s, not the role\'s', async () => {
      await close(clinicA);
      expect(await outcome(readPatient(owner))).toBe(status ? CLOSED : 'admitted');
      expect(await outcome(grantAs(owner))).toBe(decision ? DECISION_CLOSED : 'admitted');
    });

    it('a compromised credential is ended by disabling its identity: refused at once in every stage, purpose and clinic', async () => {
      await db.query("update clinical_core.identities set status='disabled' where person_id=$1 and identity_pool='workforce'", [practitioner]);
      for (const work of [readPatient(practitioner), readPatient(practitioner, clinicB, patientB), grantAs(practitioner, clinicB, connectionB, artifactB)])
        expect(await outcome(work)).toBe(CLOSED);
    });

    it(`a verified replacement credential (the same person rebound to a new subject; no source writer does this): the old subject is refused; the new one ${status ? 'is refused in the closed clinic too' : 'GAP: keeps working in the closed clinic'}`, async () => {
      const replacement = `subject-replacement-${randomUUID()}`;
      await db.query("update clinical_core.identities set identity_subject=$2 where person_id=$1 and identity_pool='workforce'", [practitioner, replacement]);
      expect(await outcome(readPatient(practitioner))).toBe(CLOSED); // the old token's subject no longer resolves
      subjects.set(`workforce:${practitioner}`, replacement);
      await expect(readPatient(practitioner)).resolves.toHaveLength(1);
      await close(clinicA);
      expect(await outcome(readPatient(practitioner))).toBe(status ? CLOSED : 'admitted');
      await expect(readPatient(practitioner, clinicB, patientB)).resolves.toHaveLength(1);
    });
  });

  describe('WP2: a practitioner\'s consent decision versus authorized cleanup in a closed clinic', () => {
    it.each(['suspended', 'archived'] as const)(`a practitioner of a %s clinic records a new grant: ${decision ? 'refused, nothing written' : 'DEFECT: admitted'}`, async closed => {
      await close(clinicA, closed);
      expect(await outcome(grantAs(practitioner))).toBe(decision ? DECISION_CLOSED : 'admitted');
      expect(await history()).toEqual(decision ? [] : ['1:granted']);
    });

    it('a practitioner of a suspended clinic records a withdrawal on the patient\'s behalf, but cannot add a new grant', async () => {
      await grantAs(practitioner);
      await close(clinicA);
      expect(await outcome(revokeAs(practitioner))).toBe('admitted');
      expect(await history()).toEqual(['1:granted', '2:revoked']);
      expect(await outcome(grantAs(practitioner))).toBe(decision ? DECISION_CLOSED : 'admitted');
    });

    it('a suspended member cannot use withdrawal-only access; the patient can still withdraw', async () => {
      await grantAs(practitioner);
      await close(clinicA);
      await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [clinicA, practitioner]);
      expect(await outcome(revokeAs(practitioner))).toMatch(/^refused:/);
      expect(await history()).toEqual(['1:granted']);
      await expect(revokeAs(consumer, clinicA, connectionA, 'consumer')).resolves.toHaveLength(1);
      expect(await history()).toEqual(['1:granted', '2:revoked']);
    });

    it(`a retry after the suspension: ${decision ? 'refused before replay or version checks, no second version' : 'the deployed answer is the version conflict, not a refusal'}`, async () => {
      await expect(grantAs(practitioner)).resolves.toHaveLength(1);
      await close(clinicA);
      expect(await outcome(grantAs(practitioner))).toBe(decision ? DECISION_CLOSED : 'refused:operation_refused:consent_already_active');
      expect(await history()).toEqual(['1:granted']);
    });

    it('cross-clinic: clinic B keeps deciding while A is closed, and A\'s connection cannot be reached from B\'s session', async () => {
      await close(clinicA);
      await expect(grantAs(practitioner, clinicB, connectionB, artifactB)).resolves.toHaveLength(1);
      expect(await outcome(grantAs(practitioner, clinicB, connectionA, artifactA))).toMatch(/^refused:/);
      expect(await history(connectionA)).toEqual([]);
      expect(await history(connectionB)).toEqual(['1:granted']);
    });

    it('the retention service runs in a closed clinic (it is not a member and never calls the decision functions); disabled or unreleased, it is refused', async () => {
      await db.query(`insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
        values($1,$2,$3,repeat('a',64),$4,clock_timestamp()-interval '1 hour')`, [`fictional-${service}`, service, subject(service), reviewer]);
      const sweep = () => as(service, clinicA, 'consent_management', 'select clinical_private.list_privacy_export_cleanup_for_retention(25) as items');
      await close(clinicA, 'archived');
      await expect(sweep()).resolves.toEqual([{ items: [] }]);
      await db.query('update clinical_private.privacy_retention_service_releases set revoked_at=clock_timestamp() where service_person_id=$1', [service]);
      expect(await outcome(sweep())).toMatch(/retention_service_release_required/);
      await db.query("update clinical_core.identities set status='disabled' where person_id=$1", [service]);
      expect(await outcome(sweep())).toBe(CLOSED);
    });

    it('recording cleanup is refused in a closed clinic by its own deployed operator check, in every stage; so is placing a legal hold (FINDING)', async () => {
      await db.query(`insert into clinical_private.recording_cleanup_operators(organization_id,operator_id,reviewed_by,evidence_sha256,approved_at,expires_at)
        values($1,$2,$3,repeat('b',64),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`, [clinicA, operator, reviewer]);
      const work = () => as(operator, clinicA, 'consent_management', 'select clinical_private.list_recording_cleanup_work(null,25) as work');
      const hold = () => as(operator, clinicA, 'consent_management', "select clinical_private.place_recording_legal_hold($1,'litigation') as id", [patientA]);
      await expect(work()).resolves.toHaveLength(1);
      await close(clinicA);
      expect(await outcome(work())).toMatch(/recording_cleanup_operator_required/);
      expect(await outcome(hold())).toMatch(/recording_cleanup_operator_required/);
    });
  });

  if (decision) describe('the BLOCKED consent-decision successor itself', () => {
    const prosrc = async (signature: string) => (await db.query<{ h: string | null }>(
      "select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as h from pg_proc p where p.oid=to_regprocedure($1)", [signature])).rows[0]?.h ?? null;
    const refused = async (sql: string, reason: string) => { await expect(db.exec(sql)).rejects.toThrow(reason); await db.exec('rollback'); };

    it('is exactly the successor, cannot apply twice, keeps the API grants and does not expose its helper', async () => {
      expect({ grant: await prosrc(GRANT), revoke: await prosrc(REVOKE) }).toEqual(SUCCESSOR);
      for (const file of [DECISION, DECISION_ROLLBACK]) for (const hash of [...Object.values(PARENT), ...Object.values(SUCCESSOR)]) expect(file).toContain(hash);
      await refused(DECISION, 'consent_decision_parent_refused');
      const privileges = (await db.query<{ grant: boolean; revoke: boolean; helper: boolean }>(`select
        has_function_privilege('clinical_core_api', to_regprocedure($1), 'EXECUTE') as grant,
        has_function_privilege('clinical_core_api', to_regprocedure($2), 'EXECUTE') as revoke,
        has_function_privilege('clinical_core_api', to_regprocedure($3), 'EXECUTE') as helper`, [GRANT, REVOKE, HELPER])).rows[0];
      expect(privileges).toEqual({ grant: true, revoke: true, helper: false });
    });

    it('its rollback restores both parents byte for byte and the gap returns; it refuses to run twice; reapplying restores the successor', async () => {
      await db.exec(DECISION_ROLLBACK);
      expect({ grant: await prosrc(GRANT), revoke: await prosrc(REVOKE), helper: await prosrc(HELPER) }).toEqual({ ...PARENT, helper: null });
      await close(clinicA);
      await expect(grantAs(practitioner)).resolves.toHaveLength(1);
      await refused(DECISION_ROLLBACK, 'consent_decision_rollback_refused');
      await db.exec(DECISION);
      expect({ grant: await prosrc(GRANT), revoke: await prosrc(REVOKE) }).toEqual(SUCCESSOR);
    });

    it('leaves the status successor in place and its rollback still applies over it', async () => {
      expect(STATUS_ROLLBACK).toContain('clinic_status_rollback_refused');
      expect(await prosrc('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')).toBe('4187ce781d95640caa788e1a9a2a49b7d59103bc3b0fa2f37ae85de99955201b');
    });

    it('refuses a synthetic-staging schema and a drifted parent', async () => {
      const synthetic = new PGlite({ extensions: { pgcrypto } });
      try {
        const manifest = JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json', 'utf8')) as { migrations: Array<{ file: string }> };
        for (const migration of manifest.migrations) await synthetic.exec(readFileSync('infra/aws-clinical-core/migrations/' + migration.file, 'utf8'));
        await expect(synthetic.exec(DECISION)).rejects.toThrow('consent_decision_schema_refused');
      } finally { await synthetic.close(); }
      await db.exec(DECISION_ROLLBACK);
      await db.exec(`create or replace function clinical_core.revoke_consent_grant(_connection_id uuid,_scope text,_reason_code text)
        returns table(consent_id uuid, connection_id uuid, scope text, status text, version integer, recorded_at timestamptz)
        language plpgsql security definer set search_path = '' as $$ begin raise exception 'drifted'; end $$`);
      await refused(DECISION, 'consent_decision_parent_refused');
      expect(await prosrc(HELPER)).toBeNull();
    }, 120_000);
  });
});
