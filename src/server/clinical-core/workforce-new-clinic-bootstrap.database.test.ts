import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import { WORKFORCE_CLINIC_BOOTSTRAP_CANDIDATE_SHA256, WORKFORCE_CLINIC_BOOTSTRAP_ROLLBACK_SHA256 } from './workforce-clinic-bootstrap';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from './database';
import { BOOTSTRAP_OPERATOR_LISTING_CANDIDATE_SHA256, BOOTSTRAP_OPERATOR_LISTING_ROLLBACK_SHA256, createPlatformOperatorConsoleApi } from './platform-operator-console';

/**
 * The distinct new-clinic door, on the assembled 106-migration schema with the onboarding parents, the
 * current-membership setter, the approval-authority successor and the BLOCKED bootstrap candidate. A practitioner who
 * creates a NEW clinic becomes its active owner in one transaction and is admitted to that clinic only; existing-clinic
 * applicants still wait for the clinic's approval, and an operator-approved proposal is still held. Fictional clinics,
 * people, subjects and addresses. Two-session races are in scripts/qualify-workforce-bootstrap-native.mjs.
 */
const FILES = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const BOOTSTRAP = 'infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap-rollback.sql';
const DISCOVERY = 'infra/aws-clinical-core/source-candidates/workforce-membership-discovery.sql';
const LISTING = 'infra/aws-clinical-core/source-candidates/workforce-bootstrap-operator-listing.sql';
const LISTING_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-bootstrap-operator-listing-rollback.sql';
const EVENT_ORDER = 'infra/aws-clinical-core/source-candidates/workforce-bootstrap-operator-event-order.sql';
const EVENT_ORDER_ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-bootstrap-operator-event-order-rollback.sql';
const EVENT_ORDER_SHA256 = 'a03d96ed3dd676ec105807c9da92ebde55b5f801f39ad94fe4bba993a5cd2559';
const EVENT_ORDER_ROLLBACK_SHA256 = 'c7b4ba0735d8b743a5614bdaa8b98a29c3331e2c800dd1892659802c8a654dfb';
const LIST_SIGNATURE = 'clinical_private.list_bootstrapped_workforce_clinics(text)';
const digest = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const sha = (file: string) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const ASSURED = 'verified_email_and_mfa';
const BOOT_SIGNATURE = 'clinical_private.bootstrap_workforce_clinic(uuid,text,text,text,text)';
const READ_SIGNATURE = 'clinical_private.workforce_clinic_bootstrap_for_subject(text)';
const SUSPEND_SIGNATURE = 'clinical_private.suspend_bootstrapped_workforce_clinic(uuid,text,text)';

type Actor = { person: string; subject: string; org: string; email: string };
const clinicA = randomUUID(), clinicB = randomUUID();
const actor = (org: string, label: string): Actor => {
  const person = randomUUID();
  return { person, subject: randomUUID(), org, email: `${label}.${person.slice(0, 8)}@clinic.fictional.example` };
};
const ownerA = actor(clinicA, 'owner.a'), adminAB = actor(clinicA, 'admin.ab');
const operator = randomUUID();
const patientA = randomUUID();
let db: PGlite;

async function exec(file: string) {
  for (const [index, statement] of splitPostgresStatements(readFileSync(file, 'utf8')).entries()) {
    try { await db.exec(statement); } catch (error) { throw new Error(`${file} statement ${index + 1}: ${String(error)}`); }
  }
}
async function person(who: Actor, role: string | null) {
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
  await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [who.person, who.subject, digest(who.email)]);
  if (role) await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,$3,'active')", [who.org, who.person, role]);
}
const refusal = async (work: Promise<unknown>) => {
  try { await work; } catch (error) { return { code: (error as { code?: string }).code, message: (error as { message?: string }).message }; }
  throw new Error('expected a refusal');
};
const asRole = <T>(role: string, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work(tx);
});
const asMember = <T>(subject: string, clinic: string, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [subject, clinic]);
  return work(tx);
});
const json = async (tx: Transaction, sql: string, params: unknown[]) => (await tx.query<{ r: Record<string, unknown> }>(sql, params)).rows[0]!.r;
type Applicant = { subject: string; email: string };
const applicant = (label: string): Applicant => { const subject = randomUUID(); return { subject, email: `${label}.${subject.slice(0, 8)}@applicant.fictional.example` }; };
const bootstrap = (who: Applicant, label: string, request = randomUUID(), assurance = ASSURED, emailDigest = digest(who.email)) =>
  asRole('clinical_workforce_application', tx => json(tx, `select clinical_private.bootstrap_workforce_clinic($1,$2,$3,$4,$5) as r`,
    [request, who.subject, emailDigest, label, assurance]));
const bootstrapStatus = (subject: string) => asRole('clinical_workforce_application', async tx =>
  (await tx.query<{ r: Record<string, unknown> | null }>('select clinical_private.workforce_clinic_bootstrap_for_subject($1) as r', [subject])).rows[0]!.r);
const suspend = (operatorSubject: string, organization: unknown, reason: string) => asRole('clinical_workforce_operator', tx =>
  json(tx, 'select clinical_private.suspend_bootstrapped_workforce_clinic($1,$2,$3) as r', [organization, operatorSubject, reason]));
/** Whether the current-membership setter admits this subject to this clinic now: what every gated clinical route asks. */
const admitted = async (subject: string, clinic: unknown) => {
  try { await asMember(subject, clinic as string, async () => undefined); return true; } catch (error) {
    if (/workforce_membership_refused/.test(String(error))) return false; throw error;
  }
};
/** Clinical authority inside the selected clinic: the role check, and the patient rows row-level security returns. */
const clinicalView = (subject: string, clinic: unknown) => asMember(subject, clinic as string, async tx => ({
  role: (await tx.query<{ ok: boolean }>('select clinical_private.has_clinical_role(clinical_private.organization_id()) as ok', [])).rows[0]!.ok,
  patients: (await tx.query<{ organization_id: string }>('select organization_id from clinical_core.patient_records', [])).rows.map(row => row.organization_id),
}));
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string | number }>(sql, params)).rows[0]!.n);
const canExecute = async (role: string, signature: string) => (await db.query<{ ok: boolean | null }>(
  "select case when to_regprocedure($2) is null then null else has_function_privilege($1,to_regprocedure($2),'EXECUTE') end as ok", [role, signature])).rows[0]!.ok;
const release = (enabled: boolean) => db.query('update clinical_private.workforce_clinic_bootstrap_release set enabled=$1 where singleton', [enabled]);
const ROLES = ['clinical_core_api', 'clinical_workforce_application', 'clinical_workforce_operator'];

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(106);
  expect(manifest.migrations.some((m: { file: string }) => /onboarding|approval-authority|current-membership|bootstrap/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const file of FILES) await exec(file);
  for (const [id, label] of [[clinicA, 'FICTIONAL CLINIC A'], [clinicB, 'FICTIONAL CLINIC B']]) await db.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [id, label]);
  await person(ownerA, 'owner'); await person(adminAB, 'admin');
  await db.query(`insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'Fictional','Patient')`,
    [patientA, clinicA, `patient_${patientA.replaceAll('-', '')}`]);
  await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active')", [operator]);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('before the bootstrap candidate (failing-before evidence)', () => {
  it('a practitioner creating a new clinic has no path to immediate access: the operator-approved clinic is held', async () => {
    expect(await canExecute('clinical_workforce_application', BOOT_SIGNATURE)).toBeNull();
    const proposer = applicant('proposer');
    const request = randomUUID();
    await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)',
      [request, proposer.subject, digest(proposer.email), 'create_clinic', null, 'FICTIONAL PROPOSED CLINIC']));
    const approved = await asRole('clinical_workforce_operator', tx => json(tx,
      'select clinical_private.review_workforce_clinic_proposal_v2($1,true,$2,$3) as r', [request, operator, 'clinic_proposal_verified']));
    expect(approved).toMatchObject({ status: 'approved', activation: 'held' });
    expect(await admitted(proposer.subject, approved.organizationId)).toBe(false);
  });
});

describe('the new-clinic bootstrap candidate', () => {
  beforeAll(async () => { await exec(BOOTSTRAP); }, 60_000);

  it('names its parent by hash, and the adapter pins the candidate and rollback it was reviewed against', () => {
    expect(readFileSync(BOOTSTRAP, 'utf8')).toContain(sha(FILES[5]!));
    expect(sha(BOOTSTRAP)).toBe(WORKFORCE_CLINIC_BOOTSTRAP_CANDIDATE_SHA256);
    expect(sha(ROLLBACK)).toBe(WORKFORCE_CLINIC_BOOTSTRAP_ROLLBACK_SHA256);
  });

  it('is off until the table owner switches its release row on, and no API role can switch it', async () => {
    const who = applicant('off');
    expect(await refusal(bootstrap(who, 'FICTIONAL OFF CLINIC'))).toMatchObject({ message: 'workforce_clinic_bootstrap_not_released' });
    for (const role of ROLES) {
      expect((await refusal(asRole(role, tx => tx.query('update clinical_private.workforce_clinic_bootstrap_release set enabled=true')))).message).toMatch(/permission denied/);
    }
    expect(await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps')).toBe(0);
    expect(await bootstrapStatus(who.subject)).toBeNull();
  });

  it('each door is callable by exactly its own role, and no API role can read or write the bootstrap tables', async () => {
    expect(await canExecute('clinical_workforce_application', BOOT_SIGNATURE)).toBe(true);
    expect(await canExecute('clinical_workforce_application', READ_SIGNATURE)).toBe(true);
    expect(await canExecute('clinical_workforce_operator', SUSPEND_SIGNATURE)).toBe(true);
    for (const [role, signature] of [['clinical_core_api', BOOT_SIGNATURE], ['clinical_workforce_operator', BOOT_SIGNATURE],
      ['clinical_core_api', SUSPEND_SIGNATURE], ['clinical_workforce_application', SUSPEND_SIGNATURE], ['clinical_core_api', READ_SIGNATURE],
      ['public', BOOT_SIGNATURE]] as const) expect(await canExecute(role, signature)).toBe(false);
    for (const role of ROLES) for (const table of ['workforce_clinic_bootstraps', 'workforce_clinic_bootstrap_events', 'workforce_clinic_bootstrap_release']) {
      expect((await refusal(asRole(role, tx => tx.query(`select * from clinical_private.${table}`)))).message).toMatch(/permission denied/);
    }
  });

  describe('released (in this fictional database only)', () => {
    beforeAll(async () => { await release(true); });

    it('makes the verified subject the active owner of a new, empty clinic, admitted to that clinic only', async () => {
      const founder = applicant('founder');
      const result = await bootstrap(founder, 'FICTIONAL NEW CLINIC');
      expect(result).toMatchObject({ status: 'active', clinicalAccess: 'available', duplicate: false });
      const clinic = result.organizationId as string;
      expect([clinicA, clinicB]).not.toContain(clinic);
      expect(await admitted(founder.subject, clinic)).toBe(true);
      expect(await admitted(founder.subject, clinicA)).toBe(false);
      expect(await admitted(founder.subject, clinicB)).toBe(false);
      // Inside the new clinic: clinical authority, and not one of another clinic's patients.
      expect(await clinicalView(founder.subject, clinic)).toEqual({ role: true, patients: [] });
      expect(await count('select count(*) as n from clinical_core.organization_memberships where organization_id=$1', [clinic])).toBe(1);
      expect(await count('select count(*) as n from clinical_core.patient_records where organization_id=$1', [clinic])).toBe(0);
      // Clinic A still sees its own patient, and nothing about the new clinic.
      expect((await clinicalView(ownerA.subject, clinicA)).patients).toEqual([clinicA]);
      expect(await bootstrapStatus(founder.subject)).toMatchObject({ organizationId: clinic, status: 'active', clinicalAccess: 'available' });
    });

    it('existing-clinic applicants still wait: a join request to clinic A grants nothing until the clinic approves it', async () => {
      const joiner = applicant('joiner');
      const request = randomUUID();
      await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)',
        [request, joiner.subject, digest(joiner.email), 'join', clinicA, null]));
      expect(await admitted(joiner.subject, clinicA)).toBe(false);
      expect(await count("select count(*) as n from clinical_private.workforce_access_requests where id=$1 and status='pending'", [request])).toBe(1);
      // The bootstrap names no clinic: there is no argument through which it could join clinic A.
      const definition = (await db.query<{ args: string }>("select pg_get_function_arguments(to_regprocedure($1)) as args", [BOOT_SIGNATURE])).rows[0]!.args;
      expect(definition).not.toMatch(/organization/);
    });

    it('a member of clinic A who creates a new clinic keeps exactly their clinic-A access, and the new clinic stays separate', async () => {
      const result = await bootstrap(adminAB, 'FICTIONAL SECOND CLINIC');
      const clinic = result.organizationId as string;
      expect(await admitted(adminAB.subject, clinic)).toBe(true);
      expect(await admitted(adminAB.subject, clinicA)).toBe(true);
      expect(await clinicalView(adminAB.subject, clinic)).toEqual({ role: true, patients: [] });
      expect((await clinicalView(adminAB.subject, clinicA)).patients).toEqual([clinicA]);
      expect(await count('select count(*) as n from clinical_core.persons where id=$1', [adminAB.person])).toBe(1);
    });

    it('needs the attested assurance; any other value creates nothing', async () => {
      const who = applicant('unassured');
      for (const assurance of ['verified_email', 'mfa', '']) {
        expect((await refusal(bootstrap(who, 'FICTIONAL UNASSURED', randomUUID(), assurance))).message)
          .toMatch(/workforce_bootstrap_assurance_required|workforce_bootstrap_invalid/);
      }
      expect(await bootstrapStatus(who.subject)).toBeNull();
    });

    it('a lost-reply retry converges on its request id; the same id under another account, address or name is a conflict', async () => {
      const who = applicant('retry'), other = applicant('switched');
      const request = randomUUID();
      const first = await bootstrap(who, 'FICTIONAL RETRY CLINIC', request);
      const again = await bootstrap(who, '  FICTIONAL RETRY CLINIC ', request);
      expect(again).toMatchObject({ organizationId: first.organizationId, membershipId: first.membershipId, duplicate: true, clinicalAccess: 'available' });
      // An account switch between the attempt and its retry: the other account cannot claim this clinic.
      expect(await refusal(bootstrap(other, 'FICTIONAL RETRY CLINIC', request))).toMatchObject({ message: 'workforce_bootstrap_conflict' });
      expect(await refusal(bootstrap(who, 'FICTIONAL RENAMED CLINIC', request))).toMatchObject({ message: 'workforce_bootstrap_conflict' });
      expect(await refusal(bootstrap(who, 'FICTIONAL RETRY CLINIC', request, ASSURED, digest(other.email)))).toMatchObject({ message: 'workforce_bootstrap_conflict' });
      expect(await admitted(other.subject, first.organizationId)).toBe(false);
      expect(await bootstrapStatus(other.subject)).toBeNull();
      expect(await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps where lower(identity_subject)=lower($1)', [who.subject])).toBe(1);
    });

    it('one bootstrapped clinic per account: a second request id is refused by name, and the first clinic is unchanged', async () => {
      const who = applicant('second.tab');
      const first = await bootstrap(who, 'FICTIONAL FIRST TAB');
      expect(await refusal(bootstrap(who, 'FICTIONAL SECOND TAB'))).toMatchObject({ message: 'workforce_clinic_bootstrap_exists' });
      expect(await bootstrapStatus(who.subject)).toMatchObject({ organizationId: first.organizationId });
      expect(await count("select count(*) as n from clinical_core.organizations where organization_label='FICTIONAL SECOND TAB'")).toBe(0);
    });

    it('two people may give their clinics the same name and still get two separate clinics', async () => {
      const one = applicant('same.name.one'), two = applicant('same.name.two');
      const a = await bootstrap(one, 'FICTIONAL SHARED NAME'), b = await bootstrap(two, 'FICTIONAL SHARED NAME');
      expect(a.organizationId).not.toBe(b.organizationId);
      expect(await admitted(one.subject, b.organizationId)).toBe(false);
      expect(await admitted(two.subject, a.organizationId)).toBe(false);
    });

    it('refuses a pending operator proposal, an address bound to another account, and a registered operator', async () => {
      const proposer = applicant('pending.proposal');
      await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)',
        [randomUUID(), proposer.subject, digest(proposer.email), 'create_clinic', null, 'FICTIONAL PENDING PROPOSAL']));
      expect(await refusal(bootstrap(proposer, 'FICTIONAL BYPASS'))).toMatchObject({ message: 'workforce_request_pending' });
      const impostor = applicant('impostor');
      expect(await refusal(bootstrap(impostor, 'FICTIONAL IMPOSTOR', randomUUID(), ASSURED, digest(ownerA.email)))).toMatchObject({ message: 'workforce_binding_conflict' });
      expect(await refusal(bootstrap({ subject: operator, email: 'operator@fictional.example' }, 'FICTIONAL OPERATOR CLINIC'))).toMatchObject({ message: 'workforce_operator_refused' });
      for (const subject of [proposer.subject, impostor.subject, operator]) expect(await bootstrapStatus(subject)).toBeNull();
    });

    it('a platform operator\'s suspension ends the clinic\'s access for its owner and staff; a replay restores nothing', async () => {
      const founder = applicant('suspended');
      const request = randomUUID();
      const result = await bootstrap(founder, 'FICTIONAL SUSPENDED CLINIC', request);
      const clinic = result.organizationId as string;
      const staff = actor(clinic, 'staff.suspended');
      await person(staff, 'practitioner');
      expect(await admitted(staff.subject, clinic)).toBe(true);
      expect(await refusal(suspend(randomUUID(), clinic, 'security_concern'))).toMatchObject({ message: 'workforce_operator_refused' });
      expect(await refusal(suspend(operator, clinic, 'because'))).toMatchObject({ message: 'workforce_bootstrap_suspension_invalid' });
      expect(await suspend(operator, clinic, 'security_concern')).toMatchObject({ status: 'suspended', duplicate: false });
      expect(await admitted(founder.subject, clinic)).toBe(false);
      expect(await admitted(staff.subject, clinic)).toBe(false);
      expect(await suspend(operator, clinic, 'security_concern')).toMatchObject({ duplicate: true });
      expect(await bootstrap(founder, 'FICTIONAL SUSPENDED CLINIC', request)).toMatchObject({ duplicate: true, status: 'suspended', clinicalAccess: 'not_available' });
      expect(await refusal(bootstrap(founder, 'FICTIONAL COMEBACK CLINIC'))).toMatchObject({ message: 'workforce_clinic_bootstrap_exists' });
      expect(await admitted(founder.subject, clinic)).toBe(false);
      expect(await bootstrapStatus(founder.subject)).toMatchObject({ status: 'suspended', suspensionReason: 'security_concern', clinicalAccess: 'not_available' });
      // The record of it is append-only.
      expect((await refusal(db.query("update clinical_private.workforce_clinic_bootstrap_events set reason_code='operator_request' where request_id=$1", [request]))).message).toMatch(/append|not allowed|update/i);
      expect(await count("select count(*) as n from clinical_private.workforce_clinic_bootstrap_events where request_id=$1", [request])).toBe(2);
    });

    it('an operator who is the clinic\'s own owner cannot suspend or vouch for it, and an unknown clinic is not found', async () => {
      const both = applicant('owner.operator');
      const result = await bootstrap(both, 'FICTIONAL SELF CLINIC');
      await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active')", [both.subject]);
      expect(await refusal(suspend(both.subject, result.organizationId, 'operator_request'))).toMatchObject({ message: 'workforce_self_approval_refused' });
      expect(await refusal(suspend(operator, clinicA, 'operator_request'))).toMatchObject({ message: 'workforce_clinic_bootstrap_not_found' });
      expect(await admitted(ownerA.subject, clinicA)).toBe(true);
    });

    describe('with the subject-only clinic discovery a first choice reads (coverage)', () => {
      beforeAll(async () => { await exec(DISCOVERY); }, 60_000);
      const discovered = (subject: string) => asRole('clinical_core_api', tx =>
        json(tx, 'select clinical_private.discover_current_workforce_memberships($1) as r', [subject]));

      it('a new clinic is the owner\'s one choice; once suspended it is neither a choice nor pending, for owner and staff alike', async () => {
        const founder = applicant('discovered');
        const result = await bootstrap(founder, 'FICTIONAL DISCOVERED CLINIC');
        const clinic = result.organizationId as string;
        const staff = actor(clinic, 'staff.discovered');
        await person(staff, 'staff');
        expect(await discovered(founder.subject)).toEqual({ clinics: [{ organizationId: clinic, name: 'FICTIONAL DISCOVERED CLINIC', role: 'owner' }], pending: [] });
        expect((await discovered(staff.subject)).clinics).toEqual([{ organizationId: clinic, name: 'FICTIONAL DISCOVERED CLINIC', role: 'staff' }]);
        // Two people may use one name; each discovers only their own clinic.
        const namesake = applicant('namesake');
        const other = await bootstrap(namesake, 'FICTIONAL DISCOVERED CLINIC');
        expect(other.organizationId).not.toBe(clinic);
        expect((await discovered(namesake.subject)).clinics).toEqual([{ organizationId: other.organizationId, name: 'FICTIONAL DISCOVERED CLINIC', role: 'owner' }]);
        await suspend(operator, clinic, 'identity_not_verified');
        expect(await discovered(founder.subject)).toEqual({ clinics: [], pending: [] });
        expect(await discovered(staff.subject)).toEqual({ clinics: [], pending: [] });
        expect((await discovered(namesake.subject)).clinics).toHaveLength(1);
        // A member of clinic A who never created a clinic keeps exactly clinic A.
        expect(((await discovered(ownerA.subject)).clinics as Array<{ organizationId: string }>).map(row => row.organizationId)).toEqual([clinicA]);
      });
    });

    describe('the operator listing candidate and the console API over it (coverage of the blocked operator path)', () => {
      beforeAll(async () => { await exec(LISTING); await exec(EVENT_ORDER); }, 60_000);
      const listed = (operatorSubject: string) => asRole('clinical_workforce_operator', async tx =>
        (await tx.query<{ r: unknown }>('select clinical_private.list_bootstrapped_workforce_clinics($1) as r', [operatorSubject])).rows[0]!.r as Array<Record<string, unknown>>);
      /** The operator connection, as the console's services see it: role-scoped, with the candidate's refusal names classified
       * the way docs/new-clinic-onboarding-closure-2026-10-16.md asks the production data client to classify them. */
      let opened = 0;
      const operatorDatabase: ClinicalCoreDatabase = { transaction: work => db.transaction(async raw => {
        opened += 1;
        await raw.exec('set local role clinical_workforce_operator');
        const tx: ClinicalCoreTransaction = { query: async (sql, parameters = []) => {
          try {
            const values = parameters.map(value => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'uuid' ? (value as { value: string }).value : value);
            return await raw.query(sql, values as unknown[]) as never;
          } catch (error) {
            const name = String((error as { message?: unknown }).message ?? '');
            if (/^workforce_[a-z_]+$/.test(name)) throw new ClinicalCoreDatabaseRejection('operation_refused', name);
            throw error;
          }
        } };
        return work(tx);
      }) };
      const TOKEN = 'Bearer fictional.operator.token';
      const consoleApi = createPlatformOperatorConsoleApi({ database: operatorDatabase, release: 'qualification', proposalReviewRelease: 'qualification',
        suspensionRelease: 'qualification', verifiedOperatorSubject: async header => { if (header !== TOKEN) throw new Error('not an operator token'); return operator; } });
      const call = async (routeKey: string, body?: unknown, authorization = TOKEN) => {
        const answer = await consoleApi({ routeKey, headers: { authorization }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: answer.statusCode, body: JSON.parse(answer.body) as { data?: Record<string, unknown>; error?: string } };
      };

      it('names its parent by hash, and the console pins the candidate and rollback it was reviewed against', () => {
        expect(readFileSync(LISTING, 'utf8')).toContain(WORKFORCE_CLINIC_BOOTSTRAP_CANDIDATE_SHA256);
        expect(sha(LISTING)).toBe(BOOTSTRAP_OPERATOR_LISTING_CANDIDATE_SHA256);
        expect(sha(LISTING_ROLLBACK)).toBe(BOOTSTRAP_OPERATOR_LISTING_ROLLBACK_SHA256);
        expect(sha(EVENT_ORDER)).toBe(EVENT_ORDER_SHA256);
        expect(sha(EVENT_ORDER_ROLLBACK)).toBe(EVENT_ORDER_ROLLBACK_SHA256);
      });

      it('only the operator role may call it, and only an active registered operator gets an answer', async () => {
        expect(await canExecute('clinical_workforce_operator', LIST_SIGNATURE)).toBe(true);
        for (const role of ['clinical_core_api', 'clinical_workforce_application']) expect(await canExecute(role, LIST_SIGNATURE)).toBe(false);
        expect(await refusal(listed(randomUUID()))).toMatchObject({ message: 'workforce_operator_refused' });
        const retired = randomUUID();
        await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'disabled')", [retired]);
        expect(await refusal(listed(retired))).toMatchObject({ message: 'workforce_operator_refused' });
        // A clinic owner is not an operator, whatever they created.
        expect(await refusal(listed(ownerA.subject))).toMatchObject({ message: 'workforce_operator_refused' });
      });

      it('lists each clinic with every recorded decision and its reason, the decider only as a fingerprint, and never the owner', async () => {
        const founder = applicant('audited');
        const result = await bootstrap(founder, 'FICTIONAL AUDITED CLINIC');
        const clinic = result.organizationId as string;
        await suspend(operator, clinic, 'agreement_not_accepted');
        const second = randomUUID();
        await db.query("insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,'active')", [second]);
        const mine = (await listed(operator)).find(row => row.organizationId === clinic)!;
        const theirs = (await listed(second)).find(row => row.organizationId === clinic)!;
        expect(mine).toMatchObject({ clinicLabel: 'FICTIONAL AUDITED CLINIC', status: 'suspended', suspensionReason: 'agreement_not_accepted' });
        const events = mine.events as Array<Record<string, unknown>>;
        expect(events.map(event => [event.action, event.reason, event.byCaller])).toEqual([['bootstrapped', null, false], ['suspended', 'agreement_not_accepted', true]]);
        expect(events[0]!.operator).toBeNull();
        expect(events[1]!.operator).toMatch(/^[0-9a-f]{16}$/);
        // Another operator sees the same fingerprint, not "you".
        expect((theirs.events as Array<Record<string, unknown>>)[1]).toMatchObject({ operator: events[1]!.operator, byCaller: false });
        const text = JSON.stringify(await listed(second));
        for (const secret of [founder.subject, digest(founder.email), founder.email, operator, result.membershipId as string]) expect(text).not.toContain(secret);
      });

      it('keeps bootstrap before suspension when the recorded timestamps tie and UUIDs sort the other way', async () => {
        const founder = applicant('same-time');
        const request = randomUUID();
        const result = await bootstrap(founder, 'FICTIONAL SAME TIME CLINIC', request);
        await suspend(operator, result.organizationId, 'operator_request');
        // Force a clock-resolution collision in this disposable database only; restore the append-only trigger.
        await db.exec('alter table clinical_private.workforce_clinic_bootstrap_events disable trigger workforce_clinic_bootstrap_events_append_only');
        try {
          await db.query(`update clinical_private.workforce_clinic_bootstrap_events
            set occurred_at='2026-10-16T00:00:00Z',
              id=case action when 'bootstrapped' then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
                else '00000000-0000-4000-8000-000000000001'::uuid end
            where request_id=$1`, [request]);
        } finally {
          await db.exec('alter table clinical_private.workforce_clinic_bootstrap_events enable trigger workforce_clinic_bootstrap_events_append_only');
        }
        const clinic = (await listed(operator)).find(row => row.organizationId === result.organizationId)!;
        expect((clinic.events as Array<{ action: string }>).map(event => event.action))
          .toEqual(['bootstrapped', 'suspended']);
      });

      it('the console lists, suspends and reviews only through the verified operator, and records each decision', async () => {
        const founder = applicant('console');
        const clinic = (await bootstrap(founder, 'FICTIONAL CONSOLE CLINIC')).organizationId as string;
        let answer = await call('GET /clinical-core/platform-operator/bootstrapped-clinics');
        expect(answer.status).toBe(200);
        expect((answer.body.data!.clinics as Array<{ organizationId: string; status: string }>).find(row => row.organizationId === clinic)).toMatchObject({ status: 'active' });
        expect(await admitted(founder.subject, clinic)).toBe(true);
        answer = await call('POST /clinical-core/platform-operator/bootstrapped-clinics/suspension', { organizationId: clinic, reason: 'security_concern' });
        expect(answer).toEqual({ status: 200, body: { data: { organizationId: clinic, status: 'suspended', reason: 'security_concern', duplicate: false } } });
        expect(await admitted(founder.subject, clinic)).toBe(false);
        // A replay records nothing new, and there is no route that reinstates.
        expect((await call('POST /clinical-core/platform-operator/bootstrapped-clinics/suspension', { organizationId: clinic, reason: 'security_concern' })).body.data).toMatchObject({ duplicate: true });
        expect(await count("select count(*) as n from clinical_private.workforce_clinic_bootstrap_events e join clinical_private.workforce_clinic_bootstraps b using (request_id) where b.organization_id=$1", [clinic])).toBe(2);
        expect((await call('POST /clinical-core/platform-operator/bootstrapped-clinics/reinstate', { organizationId: clinic })).status).toBe(404);
        // A proposal approved through the console is held: a clinic, and nobody's patient access.
        const proposer = applicant('console.proposer');
        const request = randomUUID();
        await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)',
          [request, proposer.subject, digest(proposer.email), 'create_clinic', null, 'FICTIONAL CONSOLE PROPOSAL']));
        expect(((await call('GET /clinical-core/platform-operator/clinic-proposals')).body.data!.proposals as Array<{ id: string }>).some(row => row.id === request)).toBe(true);
        const approved = await call('POST /clinical-core/platform-operator/clinic-proposals/decision', { action: 'approve', requestId: request });
        expect(approved.body.data).toMatchObject({ action: 'approve', requestId: request, status: 'approved', activation: 'held' });
        expect(await admitted(proposer.subject, approved.body.data!.organizationId)).toBe(false);
      });

      it('a token the operator sign-in refuses, a selection or a malformed body opens no transaction', async () => {
        opened = 0;
        const clinic = (await bootstrap(applicant('untouched'), 'FICTIONAL UNTOUCHED CLINIC')).organizationId as string;
        expect(await call('POST /clinical-core/platform-operator/bootstrapped-clinics/suspension', { organizationId: clinic, reason: 'security_concern' }, 'Bearer practitioner.id.token'))
          .toEqual({ status: 403, body: { error: 'platform_operator_refused' } });
        expect((await consoleApi({ routeKey: 'GET /clinical-core/platform-operator/bootstrapped-clinics', headers: { authorization: TOKEN, 'X-Alp-Selected-Organization-Id': clinic } })).statusCode).toBe(400);
        for (const body of [{ organizationId: clinic, reason: 'because' }, { organizationId: clinic, reason: 'security_concern', operatorSubject: operator }, { organizationId: 'clinic-a', reason: 'security_concern' }]) {
          expect((await call('POST /clinical-core/platform-operator/bootstrapped-clinics/suspension', body)).status).toBe(400);
        }
        expect((await call('GET /clinical-core/platform-operator/bootstrapped-clinics', undefined, '')).body).toEqual({ error: 'operator_sign_in_required' });
        expect(opened).toBe(0);
      });

      it('its rollback removes only the read; every clinic, suspension and event stays', async () => {
        const before = [await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps'), await count('select count(*) as n from clinical_private.workforce_clinic_bootstrap_events')];
        await exec(EVENT_ORDER_ROLLBACK);
        const restored = await db.query<{ digest: string }>(`select encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as digest
          from pg_proc p where p.oid=to_regprocedure($1)`, [LIST_SIGNATURE]);
        expect(restored.rows[0]!.digest).toBe('e076188526e9d321920783dd2997df3cb7a0599db239d3b18e1a1545f5f15e58');
        expect(await canExecute('clinical_workforce_operator', LIST_SIGNATURE)).toBe(true);
        await exec(LISTING_ROLLBACK);
        expect(await canExecute('clinical_workforce_operator', LIST_SIGNATURE)).toBeNull();
        expect([await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps'), await count('select count(*) as n from clinical_private.workforce_clinic_bootstrap_events')]).toEqual(before);
        expect((await call('GET /clinical-core/platform-operator/bootstrapped-clinics')).body).toEqual({ error: 'platform_operator_unavailable' });
      });
    });

    it('switched off again, it refuses new clinics but leaves the clinics it already created as they are', async () => {
      const founder = applicant('before.off');
      const result = await bootstrap(founder, 'FICTIONAL BEFORE OFF');
      await release(false);
      try {
        expect(await refusal(bootstrap(applicant('after.off'), 'FICTIONAL AFTER OFF'))).toMatchObject({ message: 'workforce_clinic_bootstrap_not_released' });
        expect(await admitted(founder.subject, result.organizationId)).toBe(true);
      } finally { await release(true); }
    });
  });

  describe('the rollback', () => {
    it('removes every door and keeps every recorded clinic, row and event', async () => {
      const founder = applicant('rollback');
      const result = await bootstrap(founder, 'FICTIONAL ROLLBACK CLINIC');
      const before = await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps');
      await exec(ROLLBACK);
      for (const signature of [BOOT_SIGNATURE, READ_SIGNATURE, SUSPEND_SIGNATURE]) expect(await canExecute('clinical_workforce_application', signature)).toBeNull();
      expect(await count('select count(*) as n from clinical_private.workforce_clinic_bootstraps')).toBe(before);
      expect(await count('select count(*) as n from clinical_private.workforce_clinic_bootstrap_release where enabled')).toBe(0);
      expect(await admitted(founder.subject, result.organizationId)).toBe(true);
    });
  });
});
