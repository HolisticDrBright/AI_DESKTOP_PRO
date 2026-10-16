import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import { WORKFORCE_IDENTITY_RECOVERY_ROLLBACK_SHA256, WORKFORCE_IDENTITY_RECOVERY_SHA256 } from './workforce-identity-recovery';

/**
 * The lawful recovery routes after an emergency login revocation (the BLOCKED workforce-identity-recovery.sql), on the
 * real 106-migration schema with the platform-operator chain and the BLOCKED emergency revocation. Fictional rows only.
 *
 * A replacement credential: a revoked practitioner identity is bound to a new, MFA-protected account only by an approver
 * on the roster who did not propose it, and the old subject is retired for good. Custodial access: one named patient's
 * file, read-only, time-bounded, approved by a second operator, every read logged. Nothing here changes a clinic's
 * status: the compromised login stays refused throughout, while the independently authorized route reads the same file.
 */
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const REVOCATION = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-identity-recovery.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-identity-recovery-rollback.sql';
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (email: string) => sha(email.trim().toLowerCase());
const METHOD = 'fictional_reviewed_method', RETENTION = 'fictional_retention_policy';
const EVIDENCE = 'e'.repeat(64);

let db: PGlite;
const clinicA = randomUUID(), clinicB = randomUUID(), patientA = randomUUID(), patientB = randomUUID();
const ops = { first: randomUUID(), second: randomUUID(), third: randomUUID(), unlisted: randomUUID() };
type Who = { person: string; subject: string; email: string };
const who = (label: string): Who => ({ person: randomUUID(), subject: randomUUID(), email: `${label}.${randomUUID().slice(0, 8)}@clinic.fictional.example` });
const owner = who('sole.owner'), colleague = who('colleague'), compromised = who('compromised');

async function exec(file: string) {
  for (const [index, statement] of splitPostgresStatements(readFileSync(file, 'utf8')).entries()) {
    try { await db.exec(statement); } catch (error) {
      await db.exec('rollback').catch(() => undefined);
      throw new Error(`${file} statement ${index + 1}: ${String(error)}`);
    }
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  const category = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category;
  return `refused:${category ?? 'unclassified'}:${(text.match(/[a-z_]+_(?:refused|required|not_released|not_found|conflict|invalid|retired|record)\b/) ?? [text])[0]}`;
});
const CLOSED = 'refused:identity_refused:request_context_refused';
const as = (person: string, subject: string, clinic: string, sql: string, args: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [person, clinic, subject]);
  return (await tx.query(sql, args)).rows;
});
const readPatient = (w: { person: string; subject: string }, clinic = clinicA, patient = patientA) =>
  as(w.person, w.subject, clinic, 'select id from clinical_core.patient_records where id=$1', [patient]).then(rows => {
    if (rows.length !== 1) throw new Error('patient_not_visible');
    return rows;
  });
const asCurrent = (subject: string, clinic: string) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return (await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data') as r", [subject, clinic])).rows;
});
const op = (sql: string, args: unknown[]) => db.transaction(async (tx: Transaction) => {
  await tx.exec('set local role clinical_workforce_operator');
  return (await tx.query<{ r: Record<string, unknown> }>(sql, args)).rows[0]!.r;
});
const revoke = (subject: string) => op("select clinical_private.propose_workforce_identity_revocation($1,$2,$3,'suspected_compromise') as r", [ops.first, randomUUID(), subject]);
const propose = (operator: string, revoked: string, replacement: string, over: Partial<{ email: string; method: string; assurance: string; request: string }> = {}) =>
  op('select clinical_private.propose_workforce_identity_recovery($1,$2,$3,$4,$5,$6,$7,$8) as r',
    [operator, over.request ?? randomUUID(), revoked, replacement, over.email ?? digest(`replacement.${replacement}@clinic.fictional.example`),
      over.method ?? METHOD, EVIDENCE, over.assurance ?? 'mfa_totp_enrolled']);
const decide = (operator: string, proposal: unknown, approve: boolean) =>
  op('select clinical_private.decide_workforce_identity_recovery($1,$2,$3) as r', [operator, proposal, approve]);
const requestCustody = (operator: string, clinic: string, patient: string, hours = 4, request = randomUUID()) =>
  op("select clinical_private.request_workforce_custodial_access($1,$2,$3,$4,'practitioner_login_revoked',$5) as r", [operator, request, clinic, patient, hours]);
const decideCustody = (operator: string, grant: unknown, approve: boolean) =>
  op('select clinical_private.decide_workforce_custodial_access($1,$2,$3) as r', [operator, grant, approve]);
const readFile = (operator: string, grant: unknown, patient: string) =>
  op('select clinical_private.read_workforce_custodial_patient_file($1,$2,$3) as r', [operator, grant, patient]);
const identityOf = async (person: string) => (await db.query<{ identity_subject: string; status: string }>(
  "select identity_subject, status from clinical_core.identities where person_id=$1 and identity_pool='workforce'", [person])).rows[0]!;
const clinics = async () => (await db.query<{ s: string }>("select string_agg(status, ',' order by id) as s from clinical_core.organizations where id in ($1,$2)", [clinicA, clinicB])).rows[0]!.s;
const memberships = async (person: string) => (await db.query<{ s: string }>(
  "select string_agg(organization_id::text || ':' || role || ':' || status, ',' order by organization_id) as s from clinical_core.organization_memberships where person_id=$1", [person])).rows[0]!.s;
const canExecute = async (role: string, signature: string) => (await db.query<{ ok: boolean | null }>(
  "select case when to_regprocedure($2) is null then null else has_function_privilege($1,to_regprocedure($2),'EXECUTE') end as ok", [role, signature])).rows[0]!.ok;
const FUNCTIONS = ['clinical_private.propose_workforce_identity_recovery(text,uuid,text,text,text,text,text,text)',
  'clinical_private.decide_workforce_identity_recovery(text,uuid,boolean)', 'clinical_private.request_workforce_custodial_access(text,uuid,uuid,uuid,text,integer)',
  'clinical_private.decide_workforce_custodial_access(text,uuid,boolean)', 'clinical_private.read_workforce_custodial_patient_file(text,uuid,uuid)'];

beforeAll(async () => {
  const schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  for (const file of CHAIN) await exec(file);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic A'),($2,'FICTIONAL clinic B')", [clinicA, clinicB]);
  for (const w of [owner, colleague, compromised]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [w.person, 'subject_' + w.person.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [w.person, w.subject]);
    await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [w.person, w.subject, digest(w.email)]);
  }
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values
    ($1,$3,'owner'),($2,$3,'practitioner'),($1,$4,'practitioner'),($1,$5,'practitioner')`, [clinicA, clinicB, owner.person, colleague.person, compromised.person]);
  for (const [patient, clinic] of [[patientA, clinicA], [patientB, clinicB]]) {
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Custody')",
      [patient, clinic, 'patient_' + patient!.replaceAll('-', '')]);
  }
  for (const subject of Object.values(ops)) await db.query("insert into clinical_private.workforce_platform_operators(operator_subject) values($1)", [subject]);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('workforce identity recovery', () => {
  it('needs the emergency revocation first, and is pinned', async () => {
    expect(sha(read(CANDIDATE))).toBe(WORKFORCE_IDENTITY_RECOVERY_SHA256);
    expect(sha(read(ROLLBACK))).toBe(WORKFORCE_IDENTITY_RECOVERY_ROLLBACK_SHA256);
    await expect(exec(CANDIDATE)).rejects.toThrow(/identity_recovery_parent_refused/);
    await exec(REVOCATION);
    await db.query("update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after'");
    await exec(CANDIDATE);
    for (const fn of FUNCTIONS) {
      expect(await canExecute('clinical_workforce_operator', fn)).toBe(true);
      expect(await canExecute('clinical_core_api', fn)).toBe(false);
      expect(await canExecute('clinical_workforce_application', fn)).toBe(false);
    }
  });

  it('runs nothing until the owner records the verification method, the retention policy and the custodial limit; the roster starts empty', async () => {
    await revoke(owner.subject);
    expect(await outcome(propose(ops.first, owner.subject, randomUUID()))).toMatch(/workforce_identity_recovery_not_released/);
    expect(await outcome(requestCustody(ops.first, clinicA, patientA))).toMatch(/workforce_identity_recovery_not_released/);
    await expect(db.query('update clinical_private.workforce_identity_recovery_release set enabled=true')).rejects.toThrow(/check/);
    expect((await db.query('select * from clinical_private.workforce_identity_recovery_approvers')).rows).toEqual([]);
    await db.query('update clinical_private.workforce_identity_recovery_release set enabled=true, verification_method=$1, retention_policy=$2, custodial_max_hours=24',
      [METHOD, RETENTION]);
    const proposal = await propose(ops.first, owner.subject, randomUUID());
    expect(await outcome(decide(ops.second, proposal.proposalId, true))).toMatch(/workforce_operator_refused/);
    await db.query('insert into clinical_private.workforce_identity_recovery_approvers(operator_subject) values($1),($2)', [ops.second, ops.third]);
  });

  describe('a replacement credential', () => {
    const replacement = randomUUID();
    let proposalId: unknown;

    it('is offered only for a revoked login, a verified method, an MFA-enrolled replacement and an unused subject', async () => {
      expect(await outcome(propose(ops.first, colleague.subject, randomUUID()))).toMatch(/workforce_identity_recovery_invalid/);
      expect(await outcome(propose(ops.first, owner.subject, randomUUID(), { method: 'a_method_nobody_reviewed' }))).toMatch(/invalid/);
      expect(await outcome(propose(ops.first, owner.subject, randomUUID(), { assurance: 'password_only' }))).toMatch(/invalid/);
      expect(await outcome(propose(ops.first, owner.subject, owner.subject))).toMatch(/invalid/);
      expect(await outcome(propose(ops.first, owner.subject, colleague.subject))).toMatch(/workforce_identity_recovery_conflict/);
      expect(await outcome(propose(ops.first, owner.subject, randomUUID(), { email: digest(colleague.email) }))).toMatch(/conflict/);
      const request = randomUUID();
      const proposed = await propose(ops.first, owner.subject, replacement, { request });
      expect(proposed).toMatchObject({ state: 'awaiting_approval', duplicate: false });
      expect(await propose(ops.first, owner.subject, replacement, { request })).toMatchObject({ proposalId: proposed.proposalId, duplicate: true });
      expect(await outcome(propose(ops.first, owner.subject, randomUUID(), { request }))).toMatch(/conflict/);
      proposalId = proposed.proposalId;
      // Proposed is not bound: the login is still refused under both subjects.
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      expect(await outcome(readPatient({ person: owner.person, subject: replacement }))).toBe(CLOSED);
    });

    it('needs an approver on the roster who did not propose it', async () => {
      expect(await outcome(decide(ops.first, proposalId, true))).toMatch(/workforce_operator_refused/);
      await db.query('insert into clinical_private.workforce_identity_recovery_approvers(operator_subject) values($1)', [ops.first]);
      expect(await outcome(decide(ops.first, proposalId, true))).toMatch(/workforce_independent_operator_required/);
      await db.query("insert into clinical_private.workforce_platform_operators(operator_subject) values($1) on conflict do nothing", [ops.unlisted]);
      expect(await outcome(decide(ops.unlisted, proposalId, true))).toMatch(/workforce_operator_refused/);
    });

    it('approved, the practitioner signs in again with the new account in every clinic; the old subject is refused for good', async () => {
      const beforeMemberships = await memberships(owner.person);
      expect(await decide(ops.second, proposalId, true)).toMatchObject({ state: 'approved' });
      expect(await decide(ops.second, proposalId, true)).toMatchObject({ duplicate: true });
      expect(await outcome(decide(ops.second, proposalId, false))).toMatch(/conflict/);
      expect(await identityOf(owner.person)).toEqual({ identity_subject: replacement, status: 'active' });
      expect(await memberships(owner.person)).toBe(beforeMemberships);
      await expect(readPatient({ person: owner.person, subject: replacement })).resolves.toHaveLength(1);
      await expect(readPatient({ person: owner.person, subject: replacement }, clinicB, patientB)).resolves.toHaveLength(1);
      await expect(asCurrent(replacement, clinicA)).resolves.toHaveLength(1);
      // The attacker's token still names the old subject: no identity row matches it any more, under either authority.
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      expect(await outcome(asCurrent(owner.subject, clinicA))).toBe('refused:identity_refused:workforce_membership_refused');
      expect(await clinics()).toBe('active,active');
    });

    it('nothing can bind the retired subject again: no rebind, no retry, no new account, not even the table owner', async () => {
      // A second revocation and recovery that tries to go back to the old subject.
      await revoke(replacement);
      expect(await outcome(propose(ops.first, replacement, owner.subject))).toMatch(/workforce_identity_subject_retired/);
      expect(await outcome(propose(ops.first, replacement, owner.subject.toUpperCase()))).toMatch(/workforce_identity_subject_retired/);
      await expect(db.query("update clinical_core.identities set identity_subject=$2 where person_id=$1 and identity_pool='workforce'", [owner.person, owner.subject]))
        .rejects.toThrow(/workforce_identity_subject_retired/);
      const stranger = randomUUID();
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [stranger, 'subject_' + stranger.replaceAll('-', '')]);
      await expect(db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [stranger, owner.subject]))
        .rejects.toThrow(/workforce_identity_subject_retired/);
      await expect(db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [stranger, owner.subject, 'f'.repeat(64)]))
        .rejects.toThrow(/workforce_identity_subject_retired/);
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
    });

    it('a declined proposal leaves the revoked login disabled, and every record is append-only', async () => {
      const declinedFor = who('declined');
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [declinedFor.person, 'subject_' + declinedFor.person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [declinedFor.person, declinedFor.subject]);
      await revoke(declinedFor.subject);
      const proposal = await propose(ops.first, declinedFor.subject, randomUUID());
      expect(await decide(ops.third, proposal.proposalId, false)).toMatchObject({ state: 'declined' });
      expect(await identityOf(declinedFor.person)).toMatchObject({ identity_subject: declinedFor.subject, status: 'disabled' });
      for (const table of ['workforce_retired_identity_subjects', 'workforce_identity_recovery_proposals', 'workforce_identity_recovery_decisions']) {
        await expect(db.query(`delete from clinical_private.${table}`)).rejects.toThrow(/append_only_record/);
        await expect(db.query(`truncate clinical_private.${table} cascade`)).rejects.toThrow(/append_only_record/);
      }
    });
  });

  describe('custodial access to one named patient', () => {
    let grantId: unknown;
    it('the compromised login stays refused while an independently approved custodian reads the same patient file', async () => {
      await expect(readPatient(compromised)).resolves.toHaveLength(1);
      await revoke(compromised.subject);
      expect(await outcome(readPatient(compromised))).toBe(CLOSED);
      const grant = await requestCustody(ops.first, clinicA, patientA, 4);
      grantId = grant.grantId;
      expect(grant).toMatchObject({ state: 'awaiting_approval', expiresAt: null });
      expect(await outcome(readFile(ops.first, grantId, patientA))).toMatch(/workforce_custodial_access_refused/);
      expect(await outcome(decideCustody(ops.first, grantId, true))).toMatch(/workforce_independent_operator_required/);
      expect(await decideCustody(ops.third, grantId, true)).toMatchObject({ state: 'approved' });
      const file = await readFile(ops.first, grantId, patientA);
      expect(file).toMatchObject({ scope: 'patient_record', readOnly: true, file: { patientRecordId: patientA, organizationId: clinicA, lastName: 'Custody' } });
      expect(await outcome(readPatient(compromised))).toBe(CLOSED);
      expect(await clinics()).toBe('active,active');
    });

    it('refuses another patient, another clinic, another operator, an unapproved grant and an expired one', async () => {
      expect(await outcome(readFile(ops.first, grantId, patientB))).toMatch(/workforce_custodial_access_refused/);
      expect(await outcome(readFile(ops.second, grantId, patientA))).toMatch(/workforce_custodial_access_refused/);
      expect(await outcome(requestCustody(ops.first, clinicB, patientA))).toMatch(/workforce_custodial_access_refused/);
      expect(await outcome(requestCustody(ops.first, clinicA, patientA, 25))).toMatch(/workforce_identity_recovery_invalid/);
      const declined = await requestCustody(ops.first, clinicA, patientA);
      await decideCustody(ops.second, declined.grantId, false);
      expect(await outcome(readFile(ops.first, declined.grantId, patientA))).toMatch(/workforce_custodial_access_refused/);
      const short = await requestCustody(ops.first, clinicA, patientA, 1);
      await decideCustody(ops.second, short.grantId, true);
      await expect(readFile(ops.first, short.grantId, patientA)).resolves.toMatchObject({ readOnly: true });
      // Move this disposable grant's approval two hours into the past (the trigger is restored at once).
      await db.exec('alter table clinical_private.workforce_custodial_access_decisions disable trigger workforce_custodial_access_decisions_append_only');
      try {
        await db.query("update clinical_private.workforce_custodial_access_decisions set decided_at=clock_timestamp()-interval '2 hours' where grant_id=$1", [short.grantId]);
      } finally {
        await db.exec('alter table clinical_private.workforce_custodial_access_decisions enable trigger workforce_custodial_access_decisions_append_only');
      }
      expect(await outcome(readFile(ops.first, short.grantId, patientA))).toMatch(/workforce_custodial_access_refused/);
    });

    it('every read is logged by ids only, append-only, and the patient record is unchanged', async () => {
      const log = (await db.query<Record<string, unknown>>('select * from clinical_private.workforce_custodial_access_log order by accessed_at')).rows;
      expect(log).toHaveLength(2);
      expect(Object.keys(log[0]!).sort()).toEqual(['accessed_at', 'grant_id', 'id', 'operator_subject', 'patient_record_id']);
      expect(JSON.stringify(log)).not.toMatch(/Custody|Fictional|@/);
      await expect(db.query('delete from clinical_private.workforce_custodial_access_log')).rejects.toThrow(/append_only_record/);
      expect((await db.query<{ n: number }>("select count(*)::int as n from clinical_core.patient_records where id=$1 and last_name='Custody'", [patientA])).rows[0]!.n).toBe(1);
    });
  });

  describe('its rollback', () => {
    it('removes the routes, keeps every record, keeps the retired subject retired and undoes no recovery', async () => {
      const kept = (await db.query<{ n: number }>(`select (select count(*) from clinical_private.workforce_identity_recovery_proposals)
        + (select count(*) from clinical_private.workforce_custodial_access_log) + (select count(*) from clinical_private.workforce_retired_identity_subjects) as n`)).rows[0]!.n;
      await exec(ROLLBACK);
      for (const fn of FUNCTIONS) expect(await canExecute('clinical_workforce_operator', fn)).toBeNull();
      expect((await db.query<{ n: number }>(`select (select count(*) from clinical_private.workforce_identity_recovery_proposals)
        + (select count(*) from clinical_private.workforce_custodial_access_log) + (select count(*) from clinical_private.workforce_retired_identity_subjects) as n`)).rows[0]!.n).toBe(kept);
      await expect(db.query("update clinical_core.identities set identity_subject=$2 where person_id=$1 and identity_pool='workforce'", [owner.person, owner.subject]))
        .rejects.toThrow(/workforce_identity_subject_retired/);
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      await expect(exec(ROLLBACK)).rejects.toThrow(/identity_recovery_rollback_refused/);
    });
  });
});
