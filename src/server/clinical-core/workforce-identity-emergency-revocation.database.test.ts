import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { classifyDatabaseRejection } from './rds-data-database';
import type { ClinicalCoreDatabase } from './database';
import {
  WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_ROLLBACK_SHA256, WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SHA256,
  WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SUCCESSOR_PROSRC_SHA256, WorkforceProviderFailure, createWorkforceIdentityRevocation,
  type ProviderStep, type RevocationFence,
} from './workforce-identity-revocation';

/**
 * The emergency revocation of one practitioner's LOGIN (the BLOCKED workforce-identity-emergency-revocation.sql), on the
 * real 106-migration production schema. Every request runs as its service runs it: the legacy entry
 * (set_request_context with the already-issued token's person, clinic, pool and purpose) or the current-membership
 * setter, then the operation, as clinical_core_api. Fictional rows only.
 *
 * First, as deployed: a sole owner whose login is suspected compromised cannot be stopped by anything the deployed
 * schema offers (failing-before). Then, with the candidate: one recorded, reasoned decision by a separately signed-in
 * platform operator disables that workforce identity in every clinic, and the next request is refused, whatever the
 * token, while the clinic, its memberships, patients, consents and audit stay exactly as they were.
 *
 * Lock waits need two sessions, which PGlite cannot give: scripts/qualify-emergency-revocation-native.mjs runs them.
 */
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation-rollback.sql';
const STATUS = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql';
const STATUS_ROLLBACK = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status-rollback.sql';
const FENCE_GUARD = 'infra/aws-clinical-core/source-candidates/workforce-membership-fence-guard.sql';
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const PARENT_PROSRC = '36d00be99597f6b527863cece9b9e174a900b49b7c2cd2085224061954b2d0ea';
const ENTRY = 'clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)';
const PROPOSE = 'clinical_private.propose_workforce_identity_revocation(text,uuid,text,text)';
const DECIDE = 'clinical_private.decide_workforce_identity_revocation(text,uuid,text)';
const RECORD = 'clinical_private.record_workforce_identity_provider_action(text,uuid,uuid,text,text,text)';
const WORK = 'clinical_private.list_workforce_identity_revocation_work(text)';
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (email: string) => sha(email.trim().toLowerCase());
/** The body between `as $$` and `$$;` of the set_request_context definition in a file: what pg_proc.prosrc holds. */
const entryBody = (file: string) => { const text = read(file); const at = text.indexOf('function clinical_private.set_request_context');
  const start = text.indexOf('as $$', at) + 5; return text.slice(start, text.indexOf('$$;', start)); };

type Purpose = 'clinical_data' | 'consent_management' | 'identity_link';
let schema: { manifest: { migrations: Array<{ file: string }> }; files: Record<string, string> };
let db: PGlite;
const clinicA = randomUUID(), clinicB = randomUUID();
const owner = { person: randomUUID(), subject: randomUUID(), email: 'sole.owner@clinic.fictional.example' };
const colleague = { person: randomUUID(), subject: randomUUID(), email: 'colleague@clinic.fictional.example' };
const admin = { person: randomUUID(), subject: randomUUID(), email: 'admin@clinic.fictional.example' };
const consumer = randomUUID(), consumerSubject = randomUUID();
const patientA = randomUUID(), patientB = randomUUID(), connectionA = randomUUID(), artifactA = randomUUID();
const operators = { first: randomUUID(), second: randomUUID(), retired: randomUUID() };

async function exec(file: string) {
  for (const [index, statement] of splitPostgresStatements(readFileSync(file, 'utf8')).entries()) {
    try { await db.exec(statement); } catch (error) {
      // A candidate's own guard refuses inside its begin/commit; end that transaction so the next statement runs.
      await db.exec('rollback').catch(() => undefined);
      throw new Error(`${file} statement ${index + 1}: ${String(error)}`);
    }
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** One request as its legacy service runs it. */
async function as<T = unknown>(person: string, subject: string, clinic: string, purpose: Purpose, sql: string, args: unknown[] = [],
  pool: 'workforce' | 'consumer' = 'workforce'): Promise<T[]> {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_core_api');
    await tx.query("select clinical_private.set_request_context($1,$2,$3,$4,$5,'production-clinical','clinical_phi')", [person, clinic, pool, subject, purpose]);
    return (await tx.query<T>(sql, args)).rows;
  });
}
/** One request under database_current: the current-membership setter in the operation's transaction. */
const asCurrent = (subject: string, clinic: string, purpose: Purpose, sql: string, args: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_current_workforce_context($1,$2,$3)', [subject, clinic, purpose]);
  return (await tx.query(sql, args)).rows;
});
const outcome = (work: Promise<unknown>) => work.then(() => 'admitted', (error: unknown) => {
  const text = message(error);
  const category = classifyDatabaseRejection({ name: 'DatabaseErrorException', message: text })?.category;
  return `refused:${category ?? 'unclassified'}:${(text.match(/[a-z_]+_(?:refused|required|not_released|not_found|conflict|invalid|record)\b/) ?? [text])[0]}`;
});
const CLOSED = 'refused:identity_refused:request_context_refused';
const CURRENT_CLOSED = 'refused:identity_refused:workforce_membership_refused';
const readPatient = (who: typeof owner, clinic = clinicA, patient = patientA) =>
  as(who.person, who.subject, clinic, 'clinical_data', 'select id from clinical_core.patient_records where id=$1', [patient]).then(rows => {
    if (rows.length !== 1) throw new Error('patient_not_visible');
    return rows;
  });
const writePatient = (who: typeof owner, clinic = clinicA) =>
  as(who.person, who.subject, clinic, 'clinical_data', "select clinical_core.create_patient_profile($1,'Fictional','Patient') as id", [clinic]);
const linkIdentity = (who: typeof owner, clinic = clinicA) =>
  as(who.person, who.subject, clinic, 'identity_link', 'select 1');
const decideConsentAsPractitioner = (who: typeof owner) => as(who.person, who.subject, clinicA, 'consent_management',
  "select consent_id from clinical_core.record_consent_grant($1,$2,'forms_checkins','in_person','self')", [connectionA, artifactA]);
const patientOwnWithdrawal = () => as(consumer, consumerSubject, clinicA, 'consent_management',
  "select consent_id from clinical_core.revoke_consent_grant($1,'forms_checkins','patient_request')", [connectionA], 'consumer');
const asRole = <T>(role: string, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work(tx);
});
const op = (sql: string, args: unknown[]) => asRole('clinical_workforce_operator', async tx =>
  (await tx.query<{ r: Record<string, unknown> }>(sql, args)).rows[0]!.r);
const propose = (operator: string, subject: string, reason = 'suspected_compromise', request = randomUUID()) =>
  op(`select ${PROPOSE.replace(/\(.*$/, '')}($1,$2,$3,$4) as r`, [operator, request, subject, reason]);
const decide = (operator: string, proposal: unknown, decision: string) => op(`select ${DECIDE.replace(/\(.*$/, '')}($1,$2,$3) as r`, [operator, proposal, decision]);
const recordAction = (operator: string, revocation: unknown, step: string, result: string, failure: string | null, action = randomUUID()) =>
  op(`select ${RECORD.replace(/\(.*$/, '')}($1,$2,$3,$4,$5,$6) as r`, [operator, action, revocation, step, result, failure]);
const work = (operator: string) => asRole('clinical_workforce_operator', async tx =>
  (await tx.query<{ r: Array<Record<string, unknown>> }>(`select ${WORK.replace(/\(.*$/, '')}($1) as r`, [operator])).rows[0]!.r);
const release = (enabled: boolean, mode: string | null) =>
  db.query('update clinical_private.workforce_identity_revocation_release set enabled=$1, approval_mode=$2 where singleton', [enabled, mode]);
const identityStatus = async (subject: string) => (await db.query<{ status: string }>(
  "select status from clinical_core.identities where identity_pool='workforce' and identity_subject=$1", [subject])).rows[0]!.status;
const prosrc = async (signature: string) => (await db.query<{ h: string | null }>(
  "select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as h from pg_proc where oid=to_regprocedure($1)", [signature])).rows[0]?.h ?? null;
const canExecute = async (role: string, signature: string) => (await db.query<{ ok: boolean | null }>(
  "select case when to_regprocedure($2) is null then null else has_function_privilege($1,to_regprocedure($2),'EXECUTE') end as ok", [role, signature])).rows[0]!.ok;
/** Everything the revocation must leave alone: the clinic, its memberships, patients, consent history and audit. */
const custody = async () => (await db.query(`select
    (select string_agg(id::text || ':' || status, ',' order by id) from clinical_core.organizations where id in ($1,$2)) as clinics,
    (select string_agg(person_id::text || ':' || organization_id::text || ':' || role || ':' || status, ',' order by person_id, organization_id)
      from clinical_core.organization_memberships where organization_id in ($1,$2)) as memberships,
    (select count(*)::int from clinical_core.patient_records where organization_id in ($1,$2)) as patients,
    (select string_agg(version || ':' || status, ',' order by version) from clinical_core.consent_grants where connection_id=$3) as consents,
    (select count(*)::int from clinical_audit.events where organization_id in ($1,$2)) as audit`, [clinicA, clinicB, connectionA])).rows[0];

beforeAll(async () => {
  schema = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  expect(schema.manifest.migrations).toHaveLength(106);
  expect(schema.manifest.migrations.some(m => /revocation|clinic-status|onboarding|current-membership/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of schema.manifest.migrations) await db.exec(schema.files[migration.file]!);
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL clinic A'),($2,'FICTIONAL clinic B')", [clinicA, clinicB]);
  for (const who of [owner, colleague, admin]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, 'subject_' + who.person.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
    await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [who.person, who.subject, digest(who.email)]);
  }
  // The sole owner of A, who also practises in B; a colleague in A; an admin of A who is not an owner.
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role) values
    ($1,$3,'owner'),($2,$3,'practitioner'),($1,$4,'practitioner'),($1,$5,'admin')`, [clinicA, clinicB, owner.person, colleague.person, admin.person]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [consumer, 'subject_' + consumer.replaceAll('-', '')]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [consumer, consumerSubject]);
  for (const [patient, clinic] of [[patientA, clinicA], [patientB, clinicB]]) {
    await db.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')",
      [patient, clinic, 'patient_' + patient!.replaceAll('-', '')]);
  }
  await db.query("insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values($1,$2,$3,$4,'verified',clock_timestamp())",
    [connectionA, clinicA, patientA, consumer]);
  await db.query(`insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
    values($1,$2,'forms_checkins','fictional-1',$3,'US-FICTIONAL','approved',clock_timestamp(),$4)`, [artifactA, clinicA, 'c'.repeat(64), owner.person]);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('as deployed: a sole owner whose login is suspected compromised (failing-before)', () => {
  it('the already-issued session reads, writes and records a consent decision', async () => {
    expect(await prosrc(ENTRY)).toBe(PARENT_PROSRC);
    await expect(readPatient(owner)).resolves.toHaveLength(1);
    await expect(writePatient(owner)).resolves.toHaveLength(1);
    await expect(decideConsentAsPractitioner(owner)).resolves.toHaveLength(1);
  });

  it('nothing deployed can stop it: no membership removal reaches a sole owner, and nothing writes a workforce identity', async () => {
    const ownerMembership = (await db.query<{ id: string }>("select id from clinical_core.organization_memberships where person_id=$1 and organization_id=$2", [owner.person, clinicA])).rows[0]!.id;
    // The owner cannot remove themselves, and an admin cannot remove an owner. There is no second owner.
    expect(await outcome(as(owner.person, owner.subject, clinicA, 'clinical_data', 'select clinical_core.remove_org_member($1)', [ownerMembership])))
      .toMatch(/self_suspension_refused/);
    expect(await outcome(as(admin.person, admin.subject, clinicA, 'clinical_data', 'select clinical_core.remove_org_member($1)', [ownerMembership])))
      .toMatch(/owner_role_required/);
    // The only function that changes an identity's status disables a CONSUMER identity during an owned deletion.
    const writers = (await db.query<{ name: string; src: string }>(`select p.proname as name, p.prosrc as src from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('clinical_core','clinical_private','public')
        and p.prosrc ~* 'update\\s+clinical_core\\.identities'`)).rows;
    expect(writers.map(w => w.name)).toEqual(['begin_owned_identity_deletion']);
    expect(writers[0]!.src).toMatch(/identity_pool='consumer' for update/);
    for (const role of ['clinical_core_api']) {
      expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,'clinical_core.identities','UPDATE') as ok", [role])).rows[0]!.ok).toBe(false);
    }
    expect(await canExecute('clinical_core_api', PROPOSE)).toBeNull();
  });

  it('a clinic suspension does not end it either, and would end every colleague\'s session with it', async () => {
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinicA]);
    try {
      await expect(readPatient(owner)).resolves.toHaveLength(1);
      await expect(readPatient(colleague)).resolves.toHaveLength(1);
    } finally { await db.query("update clinical_core.organizations set status='active' where id=$1", [clinicA]); }
  });
});

describe('the candidate', () => {
  beforeAll(async () => {
    for (const file of CHAIN) await exec(file);
    for (const [subject, status] of [[operators.first, 'active'], [operators.second, 'active'], [operators.retired, 'disabled']]) {
      await db.query('insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,$2)', [subject, status]);
    }
  }, 120_000);

  it('is pinned, and its entry is the parent with one share-lock added, nothing else', async () => {
    expect(sha(read(CANDIDATE))).toBe(WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SHA256);
    expect(sha(read(ROLLBACK))).toBe(WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_ROLLBACK_SHA256);
    expect(sha(entryBody(CANDIDATE))).toBe(WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SUCCESSOR_PROSRC_SHA256);
    expect(sha(entryBody(ROLLBACK))).toBe(PARENT_PROSRC);
    const added = entryBody(CANDIDATE).match(/\n {2}-- workforce-identity-emergency-revocation:[\s\S]*?\n {4}end if;\n {2}end if;\n/)?.[0];
    expect(added).toBeDefined();
    expect(entryBody(CANDIDATE).replace(added!, '\n')).toBe(entryBody(ROLLBACK));
    expect(added).toMatch(/for share;/);
    expect(added).not.toMatch(/organizations|memberships|update|delete|insert/);
  });

  it('refuses a parent other than the deployed entry, so it and the clinic-status successor never stack', async () => {
    await exec(STATUS);
    try {
      await expect(exec(CANDIDATE)).rejects.toThrow(/emergency_revocation_parent_refused/);
    } finally { await exec(STATUS_ROLLBACK); }
    expect(await prosrc(ENTRY)).toBe(PARENT_PROSRC);
    await exec(CANDIDATE);
    expect(await prosrc(ENTRY)).toBe(WORKFORCE_IDENTITY_EMERGENCY_REVOCATION_SUCCESSOR_PROSRC_SHA256);
    await expect(exec(STATUS)).rejects.toThrow(/clinic_status_parent_refused/);
  });

  it('only the platform operator role may call it; a practitioner or applicant connection has no EXECUTE', async () => {
    for (const fn of [PROPOSE, DECIDE, RECORD, WORK]) {
      expect(await canExecute('clinical_workforce_operator', fn)).toBe(true);
      expect(await canExecute('clinical_core_api', fn)).toBe(false);
      expect(await canExecute('clinical_workforce_application', fn)).toBe(false);
      expect(await canExecute('public', fn)).toBe(false);
    }
    for (const table of ['workforce_identity_revocation_release', 'workforce_identity_revocation_proposals', 'workforce_identity_revocation_decisions',
      'workforce_identity_revocations', 'workforce_identity_provider_actions']) {
      for (const role of ['clinical_core_api', 'clinical_workforce_application', 'clinical_workforce_operator']) {
        expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') as ok", [role, `clinical_private.${table}`])).rows[0]!.ok).toBe(false);
      }
    }
    await expect(as(owner.person, owner.subject, clinicA, 'clinical_data', `select ${PROPOSE.replace(/\(.*$/, '')}($1,$2,$3,'suspected_compromise')`,
      [operators.first, randomUUID(), colleague.subject])).rejects.toThrow(/permission denied/);
  });

  it('is off until the table owner records the release and the approval mode; nothing changes while it is off', async () => {
    expect(await outcome(propose(operators.first, owner.subject))).toMatch(/workforce_identity_revocation_not_released/);
    await expect(release(true, null)).rejects.toThrow(/check/);
    expect(await identityStatus(owner.subject)).toBe('active');
    await expect(readPatient(owner)).resolves.toHaveLength(1);
  });

  describe('approval mode independent_review_after: the decision takes effect at once, a second operator reviews it', () => {
    beforeAll(async () => { await release(true, 'independent_review_after'); });

    it('refuses an unregistered or retired operator, a malformed reason, and the operator\'s own workforce login', async () => {
      expect(await outcome(propose(randomUUID(), owner.subject))).toMatch(/workforce_operator_refused/);
      expect(await outcome(propose(operators.retired, owner.subject))).toMatch(/workforce_operator_refused/);
      expect(await outcome(propose(operators.first, owner.subject, 'because'))).toMatch(/workforce_identity_revocation_invalid/);
      expect(await outcome(propose(operators.first, randomUUID()))).toMatch(/workforce_identity_not_found/);
      // An operator whose subject is also a workforce login, and a workforce login sharing that login's email.
      const selfLogin = { person: randomUUID(), subject: operators.second, email: 'operator.two@clinic.fictional.example' };
      const sameEmail = { person: randomUUID(), subject: randomUUID() };
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2),($3,$4)',
        [selfLogin.person, 'subject_' + selfLogin.person.replaceAll('-', ''), sameEmail.person, 'subject_' + sameEmail.person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true),($3,'workforce',$4,true)",
        [selfLogin.person, selfLogin.subject, sameEmail.person, sameEmail.subject]);
      await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)',
        [selfLogin.person, selfLogin.subject, digest(selfLogin.email)]);
      expect(await outcome(propose(operators.second, selfLogin.subject))).toMatch(/workforce_self_approval_refused/);
      expect(await identityStatus(selfLogin.subject)).toBe('active');
      expect(await identityStatus(owner.subject)).toBe('active');
    });

    it('one decision disables the login in every clinic; the next request is refused whatever the token, records untouched', async () => {
      await expect(readPatient(owner)).resolves.toHaveLength(1);
      await expect(readPatient(owner, clinicB, patientB)).resolves.toHaveLength(1);
      await expect(asCurrent(owner.subject, clinicA, 'clinical_data', 'select 1')).resolves.toHaveLength(1);
      const before = await custody();
      const receipt = await propose(operators.first, owner.subject, 'suspected_compromise');
      expect(receipt).toMatchObject({ state: 'revoked', effect: 'disabled', review: 'awaiting_independent_review', provider: 'pending', duplicate: false });
      expect(await identityStatus(owner.subject)).toBe('disabled');
      // The same, still-valid session: every purpose, both clinics, both authorities.
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      expect(await outcome(readPatient(owner, clinicB, patientB))).toBe(CLOSED);
      expect(await outcome(writePatient(owner))).toBe(CLOSED);
      expect(await outcome(linkIdentity(owner))).toBe(CLOSED);
      expect(await outcome(decideConsentAsPractitioner(owner))).toBe(CLOSED);
      expect(await outcome(asCurrent(owner.subject, clinicA, 'clinical_data', 'select 1'))).toBe(CURRENT_CLOSED);
      expect(await outcome(asCurrent(owner.subject, clinicB, 'consent_management', 'select 1'))).toBe(CURRENT_CLOSED);
      // Retries stay refused.
      for (let attempt = 0; attempt < 3; attempt += 1) expect(await outcome(readPatient(owner))).toBe(CLOSED);
      // Nothing else moved: the clinic is active, the owner is still the owner, the patients and consents are there.
      expect(await custody()).toEqual(before);
    });

    it('an unrelated practitioner, the clinic\'s admin and the patient are not touched', async () => {
      await expect(readPatient(colleague)).resolves.toHaveLength(1);
      await expect(writePatient(colleague)).resolves.toHaveLength(1);
      await expect(readPatient(admin)).resolves.toHaveLength(1);
      await expect(asCurrent(colleague.subject, clinicA, 'clinical_data', 'select 1')).resolves.toHaveLength(1);
      // The patient's own withdrawal, in the clinic whose owner was revoked.
      await expect(patientOwnWithdrawal()).resolves.toHaveLength(1);
    });

    it('retries converge on the request id; the same id with different facts is a conflict and changes nothing', async () => {
      const request = randomUUID();
      const first = await propose(operators.first, colleague.subject, 'credential_exposed', request);
      const again = await propose(operators.first, colleague.subject, 'credential_exposed', request);
      expect(again).toMatchObject({ proposalId: first.proposalId, duplicate: true });
      expect(await outcome(propose(operators.first, colleague.subject, 'device_lost_or_stolen', request))).toMatch(/workforce_identity_revocation_conflict/);
      expect(await outcome(propose(operators.second, colleague.subject, 'credential_exposed', request))).toMatch(/workforce_identity_revocation_conflict/);
      // A second, separate proposal for an already-revoked login records itself and changes nothing.
      expect(await propose(operators.second, colleague.subject, 'security_review')).toMatchObject({ state: 'revoked', effect: 'already_disabled' });
      expect(await outcome(readPatient(colleague))).toBe(CLOSED);
    });

    it('the review needs a different operator, and a dispute never restores the login', async () => {
      const [item] = (await work(operators.second)).filter(entry => entry.reason === 'suspected_compromise' && entry.effect === 'disabled');
      expect(await outcome(decide(operators.first, item!.proposalId, 'confirm'))).toMatch(/workforce_independent_operator_required/);
      expect(await outcome(decide(operators.second, item!.proposalId, 'approve'))).toMatch(/workforce_identity_revocation_invalid/);
      expect(await decide(operators.second, item!.proposalId, 'dispute')).toMatchObject({ state: 'revoked', review: 'disputed' });
      expect(await decide(operators.second, item!.proposalId, 'dispute')).toMatchObject({ duplicate: true });
      expect(await outcome(decide(operators.second, item!.proposalId, 'confirm'))).toMatch(/workforce_identity_revocation_conflict/);
      expect(await identityStatus(owner.subject)).toBe('disabled');
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
    });

    it('a failed provider attempt stays actionable; only both steps succeeding completes it; nothing secret is stored', async () => {
      const [item] = (await work(operators.first)).filter(entry => entry.reason === 'suspected_compromise' && entry.effect === 'disabled');
      expect(item).toMatchObject({ provider: 'pending', providerUsername: owner.subject });
      const failed = randomUUID();
      expect(await recordAction(operators.first, item!.revocationId, 'disable_user', 'failed', 'throttled', failed)).toMatchObject({ provider: 'failed' });
      expect(await recordAction(operators.first, item!.revocationId, 'disable_user', 'failed', 'throttled', failed)).toMatchObject({ duplicate: true });
      expect(await outcome(recordAction(operators.first, item!.revocationId, 'disable_user', 'succeeded', null, failed))).toMatch(/conflict/);
      expect(await outcome(recordAction(operators.first, item!.revocationId, 'disable_user', 'failed', null))).toMatch(/invalid/);
      expect((await work(operators.first)).map(entry => entry.proposalId)).toContain(item!.proposalId);
      // The database refusal never depended on the provider: the login is refused while the provider side is failed.
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      await recordAction(operators.first, item!.revocationId, 'disable_user', 'succeeded', null);
      expect((await work(operators.first)).find(entry => entry.proposalId === item!.proposalId)).toMatchObject({ provider: 'pending' });
      expect(await recordAction(operators.first, item!.revocationId, 'global_sign_out', 'succeeded', null)).toMatchObject({ provider: 'complete' });
      expect((await work(operators.first)).map(entry => entry.proposalId)).not.toContain(item!.proposalId);
      const stored = JSON.stringify((await db.query(`select
        (select jsonb_agg(p) from clinical_private.workforce_identity_revocation_proposals p) as p,
        (select jsonb_agg(d) from clinical_private.workforce_identity_revocation_decisions d) as d,
        (select jsonb_agg(r) from clinical_private.workforce_identity_revocations r) as r,
        (select jsonb_agg(a) from clinical_private.workforce_identity_provider_actions a) as a`)).rows[0]);
      for (const secret of ['eyJ', '@', digest(owner.email), 'Fictional', patientA]) expect(stored).not.toContain(secret);
    });

    it('every record is append-only, even for the table owner', async () => {
      for (const [table, column] of [['workforce_identity_revocation_proposals', 'reason_code'], ['workforce_identity_revocation_decisions', 'decision'],
        ['workforce_identity_revocations', 'effect'], ['workforce_identity_provider_actions', 'outcome']]) {
        await expect(db.query(`update clinical_private.${table} set ${column}=${column}`)).rejects.toThrow(/append_only_record/);
        await expect(db.query(`delete from clinical_private.${table}`)).rejects.toThrow(/append_only_record/);
        await expect(db.query(`truncate clinical_private.${table} cascade`)).rejects.toThrow(/append_only_record/);
      }
    });
  });

  describe('approval mode second_operator_before: nothing changes until a different operator approves', () => {
    const target = { person: randomUUID(), subject: randomUUID(), email: 'target@clinic.fictional.example' };
    beforeAll(async () => {
      await release(true, 'second_operator_before');
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [target.person, 'subject_' + target.person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [target.person, target.subject]);
      await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [clinicA, target.person]);
    });

    it('a proposal alone admits the session; the proposer cannot approve; a decline changes nothing', async () => {
      const declined = await propose(operators.first, target.subject, 'practitioner_request');
      expect(declined).toMatchObject({ state: 'awaiting_approval', review: 'awaiting_independent_approval', provider: 'not_started' });
      await expect(readPatient(target)).resolves.toHaveLength(1);
      expect(await outcome(decide(operators.first, declined.proposalId, 'approve'))).toMatch(/workforce_independent_operator_required/);
      expect(await outcome(decide(operators.second, declined.proposalId, 'confirm'))).toMatch(/workforce_identity_revocation_invalid/);
      expect(await decide(operators.second, declined.proposalId, 'decline')).toMatchObject({ state: 'declined' });
      await expect(readPatient(target)).resolves.toHaveLength(1);
      expect(await identityStatus(target.subject)).toBe('active');
    });

    it('the second operator\'s approval disables it, and the next request is refused', async () => {
      const proposal = await propose(operators.second, target.subject, 'suspected_compromise');
      await expect(readPatient(target)).resolves.toHaveLength(1);
      expect(await decide(operators.first, proposal.proposalId, 'approve')).toMatchObject({ state: 'revoked', effect: 'disabled', review: 'approved' });
      expect(await outcome(readPatient(target))).toBe(CLOSED);
      expect(await outcome(asCurrent(target.subject, clinicA, 'clinical_data', 'select 1'))).toBe(CURRENT_CLOSED);
    });
  });

  describe('with the BLOCKED membership-fence guard applied as well', () => {
    const fenced = { person: randomUUID(), subject: randomUUID() };
    beforeAll(async () => {
      await release(true, 'independent_review_after');
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [fenced.person, 'subject_' + fenced.person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [fenced.person, fenced.subject]);
      await exec(FENCE_GUARD);
    });

    it('a revocation that did not begin the fence is refused whole; with the fence acknowledgement it lands', async () => {
      const request = randomUUID();
      expect(await outcome(propose(operators.first, fenced.subject, 'suspected_compromise', request))).toMatch(/membership_fence_required/);
      expect((await db.query('select 1 from clinical_private.workforce_identity_revocation_proposals where request_id=$1', [request])).rows).toHaveLength(0);
      expect(await identityStatus(fenced.subject)).toBe('active');
      const landed = await asRole('clinical_workforce_operator', async tx => {
        await tx.query("select set_config('clinical.membership_fence_ack',$1,true)", [`membership-fence/1 ${randomUUID()} subject:${fenced.subject.toLowerCase()}`]);
        return (await tx.query<{ r: Record<string, unknown> }>(`select ${PROPOSE.replace(/\(.*$/, '')}($1,$2,$3,'suspected_compromise') as r`,
          [operators.first, request, fenced.subject])).rows[0]!.r;
      });
      expect(landed).toMatchObject({ state: 'revoked', effect: 'disabled' });
    });
  });

  describe('the operator service over this database, with a fictional provider and fence (the guard is applied)', () => {
    /** The operator connection as the console's services see it: role-scoped, refusals classified as in production. */
    const operatorDatabase: ClinicalCoreDatabase = { transaction: work => db.transaction(async raw => {
      await raw.exec('set local role clinical_workforce_operator');
      return work({ query: async (sql, parameters = []) => {
        try { return await raw.query(sql, parameters as unknown[]) as never; } catch (error) {
          throw classifyDatabaseRejection({ name: 'DatabaseErrorException', message: message(error) }) ?? error;
        }
      } });
    }) };
    const fence = (): RevocationFence & { log: string[] } => {
      const log: string[] = [];
      return { log, begin: async subject => { log.push(`begin:${subject}`);
        return { acknowledgement: `membership-fence/1 ${randomUUID()} subject:${subject.toLowerCase()}`, settle: async () => { log.push(`settle:${subject}`); } }; } };
    };
    const member = async () => {
      const who = { person: randomUUID(), subject: randomUUID(), email: '' };
      await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, 'subject_' + who.person.replaceAll('-', '')]);
      await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
      await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [clinicA, who.person]);
      return who;
    };
    const body = (who: { subject: string }, requestId = randomUUID()) => ({ requestId, identitySubject: who.subject, reason: 'suspected_compromise' });

    it('with the provider down, the login is refused at once; the item stays failed until a reconciliation completes it', async () => {
      await release(true, 'independent_review_after');
      const who = await member();
      let providerUp = false;
      const calls: string[] = [];
      const provider = { revoke: async (step: ProviderStep, username: string) => {
        calls.push(`${step}:${username}`);
        if (!providerUp) throw new WorkforceProviderFailure('unavailable');
      } };
      const gate = fence();
      const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider, fence: gate, release: 'qualification' });
      await expect(readPatient(who)).resolves.toHaveLength(1);
      const result = await service.propose(operators.first, body(who));
      expect(gate.log).toEqual([`begin:${who.subject}`, `settle:${who.subject}`]);
      expect(result.summary).toMatchObject({ state: 'revoked', effect: 'disabled', provider: 'failed' });
      expect(result.provider).toEqual([{ step: 'disable_user', outcome: 'failed', failure: 'unavailable' }, { step: 'global_sign_out', outcome: 'failed', failure: 'unavailable' }]);
      expect(await outcome(readPatient(who))).toBe(CLOSED);
      providerUp = true;
      const reconciled = (await service.reconcile(operators.first)).find(item => item.summary.proposalId === result.summary.proposalId);
      expect(reconciled?.summary.provider).toBe('complete');
      // The reconciliation also retried every other incomplete revocation; this login's calls are these.
      expect(calls.filter(call => call.endsWith(who.subject))).toEqual([`disable_user:${who.subject}`, `global_sign_out:${who.subject}`, `disable_user:${who.subject}`, `global_sign_out:${who.subject}`]);
      // A retry of the same request is the same decision, and does not call the provider again once it is complete.
      const again = await service.propose(operators.first, { ...body(who), requestId: result.summary.requestId });
      expect(again.summary).toMatchObject({ proposalId: result.summary.proposalId, duplicate: true });
      expect(calls.filter(call => call.endsWith(who.subject))).toHaveLength(4);
      expect(JSON.stringify([result, reconciled, again])).not.toMatch(/eyJ|@|Fictional/);
    });

    it('a delayed provider answer never delays the refusal', async () => {
      const who = await member();
      let answer!: () => void;
      const provider = { revoke: vi.fn(() => new Promise<void>(resolve => { answer = resolve; })) };
      const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider, fence: fence(), release: 'qualification' });
      const pending = service.propose(operators.first, body(who));
      await vi.waitFor(() => expect(provider.revoke).toHaveBeenCalledTimes(1));
      expect(await outcome(readPatient(who))).toBe(CLOSED);
      expect(await outcome(asCurrent(who.subject, clinicA, 'clinical_data', 'select 1'))).toBe(CURRENT_CLOSED);
      answer();
      await vi.waitFor(() => expect(provider.revoke).toHaveBeenCalledTimes(2));
      answer();
      expect((await pending).summary.provider).toBe('complete');
    });

    it('without the fence, the guard refuses the whole revocation; a fence that cannot begin stops it before the database', async () => {
      const who = await member();
      const provider = { revoke: vi.fn(async () => undefined) };
      const unfenced = createWorkforceIdentityRevocation({ database: operatorDatabase, provider, release: 'qualification' });
      await expect(unfenced.propose(operators.first, body(who))).rejects.toMatchObject({ code: 'fence_required' });
      const broken = createWorkforceIdentityRevocation({ database: { transaction: vi.fn() } as unknown as ClinicalCoreDatabase, provider,
        fence: { begin: async () => { throw new Error('fence store unavailable'); } }, release: 'qualification' });
      await expect(broken.propose(operators.first, body(who))).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(provider.revoke).not.toHaveBeenCalled();
      expect(await identityStatus(who.subject)).toBe('active');
      await expect(readPatient(who)).resolves.toHaveLength(1);
    });

    it('a proposal awaiting a second operator calls no provider; the approval disables, fenced, and then calls it', async () => {
      await release(true, 'second_operator_before');
      const who = await member();
      const provider = { revoke: vi.fn(async () => undefined) };
      const gate = fence();
      const service = createWorkforceIdentityRevocation({ database: operatorDatabase, provider, fence: gate, release: 'qualification' });
      const proposed = await service.propose(operators.first, body(who));
      expect(proposed).toMatchObject({ summary: { state: 'awaiting_approval' }, provider: [] });
      expect(provider.revoke).not.toHaveBeenCalled();
      await expect(readPatient(who)).resolves.toHaveLength(1);
      await expect(service.decide(operators.first, { proposalId: proposed.summary.proposalId, decision: 'approve' }))
        .rejects.toMatchObject({ code: 'independent_operator_required' });
      const approved = await service.decide(operators.second, { proposalId: proposed.summary.proposalId, decision: 'approve' });
      expect(approved.summary).toMatchObject({ state: 'revoked', review: 'approved', provider: 'complete' });
      // The proposal, the refused approval and the approval each began the fence for this subject, and each settled it.
      expect(gate.log).toEqual([`begin:${who.subject}`, `settle:${who.subject}`, `begin:${who.subject}`, `settle:${who.subject}`,
        `begin:${who.subject}`, `settle:${who.subject}`]);
      expect(provider.revoke).toHaveBeenCalledTimes(2);
      expect(await outcome(readPatient(who))).toBe(CLOSED);
      await release(true, 'independent_review_after');
    });
  });

  describe('its rollback', () => {
    it('restores the parent entry exactly, removes the operator functions, keeps every record and re-enables nobody', async () => {
      const kept = (await db.query<{ n: number }>(`select
        (select count(*) from clinical_private.workforce_identity_revocation_proposals)
        + (select count(*) from clinical_private.workforce_identity_revocations)
        + (select count(*) from clinical_private.workforce_identity_provider_actions) as n`)).rows[0]!.n;
      await exec(ROLLBACK);
      expect(await prosrc(ENTRY)).toBe(PARENT_PROSRC);
      for (const fn of [PROPOSE, DECIDE, RECORD, WORK]) expect(await canExecute('clinical_workforce_operator', fn)).toBeNull();
      expect((await db.query<{ n: number }>(`select
        (select count(*) from clinical_private.workforce_identity_revocation_proposals)
        + (select count(*) from clinical_private.workforce_identity_revocations)
        + (select count(*) from clinical_private.workforce_identity_provider_actions) as n`)).rows[0]!.n).toBe(kept);
      expect(await identityStatus(owner.subject)).toBe('disabled');
      expect(await outcome(readPatient(owner))).toBe(CLOSED);
      await expect(readPatient(admin)).resolves.toHaveLength(1);
      await expect(exec(ROLLBACK)).rejects.toThrow(/emergency_revocation_rollback_refused/);
    });
  });
});

describe('the candidate on the bare production artifact', () => {
  it('refuses without the platform-operator registry and the current-membership setter, and changes nothing', async () => {
    const bare = new PGlite({ extensions: { pgcrypto } });
    try {
      for (const migration of schema.manifest.migrations) await bare.exec(schema.files[migration.file]!);
      await expect(bare.exec(read(CANDIDATE))).rejects.toThrow(/emergency_revocation_parent_refused/);
      await bare.exec('rollback').catch(() => undefined);
      expect((await bare.query<{ h: string }>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') as h from pg_proc where oid=to_regprocedure($1)", [ENTRY])).rows[0]!.h)
        .toBe(PARENT_PROSRC);
      expect((await bare.query<{ t: string | null }>("select to_regclass('clinical_private.workforce_identity_revocations')::text as t")).rows[0]!.t).toBeNull();
    } finally { await bare.close(); }
  }, 180_000);
});

describe('no service runs the legacy entry inside a read-only transaction (the share-lock would refuse there)', () => {
  it('holds for every source file that calls set_request_context', async () => {
    const files = execFileSync('git', ['grep', '-l', 'set_request_context(', '--', 'src/server', 'scripts'], { encoding: 'utf8' }).trim().split('\n')
      .filter(file => !/\.test\.|route-authority-inventory/.test(file));
    expect(files.length).toBeGreaterThan(20);
    const readOnly = /\b(?:set\s+transaction|start\s+transaction|begin)\b[^;'"`\n]*\bread\s+only\b|\bdefault_transaction_read_only\b/i;
    for (const file of files) expect([file, readOnly.test(read(file))]).toEqual([file, false]);
    // The pattern does find the read-only inspections that exist elsewhere, so a miss here is not a blind regex.
    expect(readOnly.test(read('src/server/clinical-core/telehealth-consent-copy-retained.ts'))).toBe(true);
  });
});
