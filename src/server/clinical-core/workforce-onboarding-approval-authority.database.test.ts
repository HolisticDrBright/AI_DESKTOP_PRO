import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';

/**
 * Who may decide a practitioner's application, on the assembled 106-migration schema with the onboarding parents and
 * the BLOCKED approval-authority successor. Clinic administrators act only through the current-membership setter (the
 * selected clinic and the acting person come from current rows, never from a token); the applicant service and the
 * platform operator act through their own narrow roles. Two fictional clinics, fictional people, subjects and addresses.
 *
 * The first block records what the parents allow (the failing-before evidence); every later block runs on the
 * successor. Two-session lock races are in scripts/qualify-workforce-onboarding-native.mjs; PGlite has one connection.
 */
const TOKEN_LOOKUP = 'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql';
const PARENT = 'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql';
const INVITATION_REPAIR = 'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql';
const UNIFORM = 'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql';
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority-rollback.sql';
const digest = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const sha = (file: string) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

type Actor = { person: string; subject: string; org: string; email: string };
const clinicA = randomUUID(), clinicB = randomUUID();
const actor = (org: string, label: string): Actor => {
  const person = randomUUID();
  return { person, subject: randomUUID(), org, email: `${label}.${person.slice(0, 8)}@clinic.fictional.example` };
};
const ownerA = actor(clinicA, 'owner.a'), adminA = actor(clinicA, 'admin.a'), practitionerA = actor(clinicA, 'practitioner.a');
const ownerB = actor(clinicB, 'owner.b'), adminAB = actor(clinicA, 'admin.ab');
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
  try { await work; } catch (error) { const e = error as { code?: string; message?: string }; return { code: e.code, message: e.message }; }
  throw new Error('expected a refusal');
};
/** A clinic administrator's request: the setter binds subject + selected clinic from current rows, then the operation. */
const asAdmin = <T>(who: { subject: string }, clinic: string, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [who.subject, clinic]);
  return work(tx);
});
const asRole = <T>(role: string, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec(`set local role ${role}`);
  return work(tx);
});
const json = async (tx: Transaction, sql: string, params: unknown[]) => (await tx.query<{ r: Record<string, unknown> }>(sql, params)).rows[0]!.r;
const submit = (subject: string, kind: 'join' | 'create_clinic', target: string, email = `${subject.slice(0, 8)}@applicant.fictional.example`) => {
  const request = randomUUID();
  return asRole('clinical_workforce_application', async tx => {
    await tx.query('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6)',
      [request, subject, digest(email), kind, kind === 'join' ? target : null, kind === 'create_clinic' ? target : null]);
    return { request, subject, email };
  });
};
const status = (subject: string) => asRole('clinical_workforce_application', async tx =>
  (await tx.query<{ r: Array<Record<string, unknown>> }>('select clinical_private.workforce_access_status_for_subject($1) as r', [subject])).rows[0]!.r);
const decide = (who: Actor, clinic: string, request: string, approve: boolean, reason: string, applicantDigest: string | null = null) =>
  asAdmin(who, clinic, tx => json(tx, 'select clinical_core.review_workforce_join_request_v2($1,$2,$3,$4) as r', [request, approve, reason, applicantDigest]));
const decideProposal = (operator: string, request: string, approve: boolean, reason: string) => asRole('clinical_workforce_operator', tx =>
  json(tx, 'select clinical_private.review_workforce_clinic_proposal_v2($1,$2,$3,$4) as r', [request, approve, operator, reason]));
const list = (who: Actor, clinic: string) => asAdmin(who, clinic, async tx =>
  (await tx.query<{ r: Array<Record<string, unknown>> }>('select clinical_core.list_workforce_join_requests() as r', [])).rows[0]!.r);
const revoke = (who: Actor, clinic: string, membership: string, reason: string) =>
  asAdmin(who, clinic, tx => json(tx, 'select clinical_core.revoke_workforce_membership($1,$2) as r', [membership, reason]));
/** Whether the current-membership setter admits this subject to this clinic now: what every gated clinical route asks. */
const admitted = async (subject: string, clinic: string) => {
  try { await asAdmin({ subject }, clinic, async () => undefined); return true; } catch (error) {
    if (/workforce_membership_refused/.test(String(error))) return false; throw error;
  }
};
const row = async (request: string) => (await db.query<Record<string, unknown>>(
  'select status,approved_organization_id,approved_membership_id,reviewer_person_id,operator_subject,decision_reason from clinical_private.workforce_access_requests where id=$1', [request])).rows[0]!;
const decisions = async (request: string) => (await db.query<{ action: string; reason_code: string | null }>(
  "select action,reason_code from clinical_private.workforce_access_events where request_id=$1 and action<>'submitted' order by occurred_at,id", [request])).rows;
const membership = async (id: unknown) => (await db.query<{ role: string; status: string }>('select role,status from clinical_core.organization_memberships where id=$1', [id])).rows[0];
const functionDef = async (signature: string) => (await db.query<{ def: string | null }>(
  'select case when to_regprocedure($1) is null then null else pg_get_functiondef(to_regprocedure($1)) end as def', [signature])).rows[0]!.def;
const canExecute = async (role: string, signature: string) => (await db.query<{ ok: boolean | null }>(
  'select case when to_regprocedure($2) is null then null else has_function_privilege($1,to_regprocedure($2),\'EXECUTE\') end as ok', [role, signature])).rows[0]!.ok;
const registerOperator = (subject: string, state: 'active' | 'disabled' = 'active') =>
  db.query('insert into clinical_private.workforce_platform_operators(operator_subject,status) values($1,$2)', [subject, state]);

const SIGNATURES = {
  activate: 'clinical_core.activate_my_memberships()',
  status: 'clinical_private.workforce_access_status_for_subject(text)',
  parentJoin: 'clinical_core.review_workforce_join_request(uuid,boolean)',
  parentProposal: 'clinical_private.review_workforce_clinic_proposal(uuid,boolean,text)',
  list: 'clinical_core.list_workforce_join_requests()',
  join: 'clinical_core.review_workforce_join_request_v2(uuid,boolean,text,text)',
  proposal: 'clinical_private.review_workforce_clinic_proposal_v2(uuid,boolean,text,text)',
  revoke: 'clinical_core.revoke_workforce_membership(uuid,text)',
  proposals: 'clinical_private.list_workforce_clinic_proposals(text)',
};
const parentDefinitions: Record<string, string | null> = {};

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(106);
  expect(manifest.migrations.some((m: { file: string }) => /onboarding|approval-authority|current-membership/.test(m.file))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const file of [TOKEN_LOOKUP, PARENT, INVITATION_REPAIR, UNIFORM, SETTER]) await exec(file);
  for (const [id, label] of [[clinicA, 'FICTIONAL CLINIC A'], [clinicB, 'FICTIONAL CLINIC B']]) await db.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [id, label]);
  await person(ownerA, 'owner'); await person(adminA, 'admin'); await person(practitionerA, 'practitioner'); await person(ownerB, 'owner');
  // An administrator of clinic A who is also a practitioner in clinic B: two approved clinics, one login.
  await person(adminAB, 'admin');
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'practitioner','active')", [clinicB, adminAB.person]);
  for (const signature of [SIGNATURES.activate, SIGNATURES.status, SIGNATURES.parentJoin, SIGNATURES.parentProposal]) parentDefinitions[signature] = await functionDef(signature);
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('the parents (failing-before evidence)', () => {
  it('names its parents by hash, so a changed parent cannot be reviewed against this successor', () => {
    const header = readFileSync(SUCCESSOR, 'utf8');
    expect(header).toContain(sha(PARENT));
    expect(header).toContain(sha(UNIFORM));
  });

  it('a platform operator\'s approval of a new clinic grants clinical access at once, to any operator string', async () => {
    const applicant = randomUUID();
    const { request } = await submit(applicant, 'create_clinic', 'FICTIONAL PROPOSED PARENT CLINIC');
    // No registry: any well-formed string is an operator.
    const result = await asRole('clinical_workforce_operator', tx => json(tx,
      'select clinical_private.review_workforce_clinic_proposal($1,true,$2) as r', [request, 'operator-anyone-at-all']));
    expect(await membership(result.membershipId)).toEqual({ role: 'owner', status: 'active' });
    expect(await admitted(applicant, result.organizationId as string)).toBe(true);
  });

  it('a clinic administrator approves a join request knowing only its id, with no reason, and has no queue to read', async () => {
    const { request } = await submit(randomUUID(), 'join', clinicA);
    const result = await asAdmin(adminA, clinicA, tx => json(tx, 'select clinical_core.review_workforce_join_request($1,true) as r', [request]));
    expect(result).toMatchObject({ status: 'approved' });
    expect(Object.keys(result).sort()).toEqual(['membershipId', 'organizationId', 'status']);
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='clinical_private' and table_name='workforce_access_requests'")).rows.map(r => r.column_name);
    expect(columns).not.toContain('decision_reason');
    expect(await functionDef(SIGNATURES.list)).toBeNull();
    expect(await functionDef(SIGNATURES.revoke)).toBeNull();
  });

  it('the applicant\'s status says approved but not whether clinical access exists', async () => {
    const subject = randomUUID(); const { request } = await submit(subject, 'join', clinicA);
    await asAdmin(adminA, clinicA, tx => tx.query('select clinical_core.review_workforce_join_request($1,true)', [request]));
    const [entry] = await status(subject);
    expect(entry).toMatchObject({ status: 'approved' });
    expect(entry).not.toHaveProperty('clinicalAccess');
    expect(entry).not.toHaveProperty('decisionReason');
  });
});

describe('the approval-authority successor', () => {
  beforeAll(async () => { await exec(SUCCESSOR); }, 60_000);

  describe('three interfaces, three roles', () => {
    it('the reasoned functions are the only review doors, each callable by exactly its own role', async () => {
      expect(await canExecute('clinical_core_api', SIGNATURES.parentJoin)).toBe(false);
      expect(await canExecute('clinical_workforce_operator', SIGNATURES.parentProposal)).toBe(false);
      const matrix: Array<[string, string, boolean]> = [
        ['clinical_core_api', SIGNATURES.list, true], ['clinical_core_api', SIGNATURES.join, true], ['clinical_core_api', SIGNATURES.revoke, true],
        ['clinical_core_api', SIGNATURES.proposal, false],
        ['clinical_core_api', SIGNATURES.proposals, false], ['clinical_workforce_application', SIGNATURES.proposals, false],
        ['public', SIGNATURES.proposals, false], ['clinical_workforce_operator', SIGNATURES.proposals, true],
        ['clinical_workforce_operator', SIGNATURES.proposal, true], ['clinical_workforce_operator', SIGNATURES.join, false],
        ['clinical_workforce_operator', SIGNATURES.list, false], ['clinical_workforce_operator', SIGNATURES.revoke, false],
        ['clinical_workforce_application', SIGNATURES.join, false], ['clinical_workforce_application', SIGNATURES.proposal, false],
        ['clinical_workforce_application', SIGNATURES.list, false], ['clinical_workforce_application', SIGNATURES.revoke, false],
        ['public', SIGNATURES.join, false], ['public', SIGNATURES.proposal, false], ['public', SIGNATURES.list, false], ['public', SIGNATURES.revoke, false],
      ];
      for (const [role, signature, expected] of matrix) expect([role, signature, await canExecute(role, signature)]).toEqual([role, signature, expected]);
    });

    it('no API role can read or write the operator registry, the activation holds or the revocation ledger', async () => {
      for (const table of ['workforce_platform_operators', 'workforce_clinic_activation_holds', 'workforce_membership_revocations', 'workforce_access_requests']) {
        for (const role of ['clinical_core_api', 'clinical_workforce_application', 'clinical_workforce_operator']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const { rows } = await db.query<{ ok: boolean }>('select has_table_privilege($1,$2,$3) as ok', [role, `clinical_private.${table}`, privilege]);
            expect([table, role, privilege, rows[0]!.ok]).toEqual([table, role, privilege, false]);
          }
        }
      }
    });

    it('the applicant role cannot decide anything, even with a valid request id', async () => {
      const { request } = await submit(randomUUID(), 'join', clinicA);
      expect((await refusal(asRole('clinical_workforce_application', tx => tx.query("select clinical_core.review_workforce_join_request_v2($1,true,'identity_confirmed_by_clinic',$2)", [request, 'a'.repeat(64)])))).code).toBe('42501');
      expect(await row(request)).toMatchObject({ status: 'pending' });
    });
  });

  describe('a clinic administrator decides only a request for the clinic their session selected', () => {
    it('refuses a decision without a closed-vocabulary reason, or an approval without the applicant\'s email digest', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const invalid = [
        decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', null),
        decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', 'not-a-digest'),
        decide(adminA, clinicA, app.request, true, 'not_known_to_clinic', digest(app.email)),
        decide(adminA, clinicA, app.request, true, 'they seemed fine on the phone', digest(app.email)),
        decide(adminA, clinicA, app.request, false, 'identity_confirmed_by_clinic'),
        decide(adminA, clinicA, app.request, false, 'not_known_to_clinic', digest(app.email)),
      ];
      for (const attempt of invalid) expect(await refusal(attempt)).toEqual({ code: '22023', message: 'workforce_review_invalid' });
      expect(await row(app.request)).toMatchObject({ status: 'pending', decision_reason: null });
      expect(await decisions(app.request)).toEqual([]);
    });

    it('answers an unknown id, another clinic\'s request, a non-administrator and a proposal identically, and writes nothing', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const proposal = await submit(randomUUID(), 'create_clinic', 'FICTIONAL PROPOSED CLINIC Q');
      const answers = [
        await refusal(decide(adminA, clinicA, randomUUID(), true, 'identity_confirmed_by_clinic', digest(app.email))),
        await refusal(decide(ownerB, clinicB, app.request, true, 'identity_confirmed_by_clinic', digest(app.email))),
        await refusal(decide(ownerB, clinicB, app.request, false, 'clinic_not_accepting')),
        await refusal(decide(practitionerA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email))),
        // Two approved clinics, one login: selecting clinic B (practitioner there) does not carry clinic A's admin role.
        await refusal(decide(adminAB, clinicB, app.request, true, 'identity_confirmed_by_clinic', digest(app.email))),
        // A new-clinic proposal is not a join request, whoever administers what.
        await refusal(decide(ownerA, clinicA, proposal.request, true, 'identity_confirmed_by_clinic', digest(proposal.email))),
      ];
      for (const answer of answers) expect(answer).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
      expect(await row(proposal.request)).toMatchObject({ status: 'pending' });
      expect(await decisions(app.request)).toEqual([]);
    });

    it('an administrator whose session never bound (removed, other clinic, no membership) never reaches the decision', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      for (const [who, clinic] of [[ownerB, clinicA], [{ subject: randomUUID() }, clinicA]] as const) {
        expect(String((await refusal(decide(who as Actor, clinic, app.request, true, 'identity_confirmed_by_clinic', digest(app.email)))).message)).toBe('workforce_membership_refused');
      }
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
    });

    it('approves only the applicant the administrator names; a mismatched digest is refused and writes nothing', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      expect(await refusal(decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest('someone.else@applicant.fictional.example'))))
        .toEqual({ code: '42501', message: 'workforce_review_applicant_mismatch' });
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
      // The address as the applicant typed it may differ in case and spacing; the digest is of the normalized address.
      const approved = await decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(`  ${app.email.toUpperCase()} `));
      expect(approved).toMatchObject({ status: 'approved', organizationId: clinicA, decisionReason: 'identity_confirmed_by_clinic', duplicate: false });
      expect(await membership(approved.membershipId)).toEqual({ role: 'practitioner', status: 'active' });
      expect(await row(app.request)).toMatchObject({ status: 'approved', reviewer_person_id: adminA.person, decision_reason: 'identity_confirmed_by_clinic' });
      expect(await decisions(app.request)).toEqual([{ action: 'approved', reason_code: 'identity_confirmed_by_clinic' }]);
      // Approval in clinic A is access to clinic A only.
      expect(await admitted(app.subject, clinicA)).toBe(true);
      expect(await admitted(app.subject, clinicB)).toBe(false);
      expect(await status(app.subject)).toEqual([expect.objectContaining({ status: 'approved', clinicalAccess: 'available', decisionReason: 'identity_confirmed_by_clinic' })]);
    });

    it('an administrator cannot approve themselves', async () => {
      const app = await submit(adminA.subject, 'join', clinicA, adminA.email);
      expect(await refusal(decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(adminA.email))))
        .toEqual({ code: '42501', message: 'workforce_self_approval_refused' });
      await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.withdraw_workforce_access_request($1,$2)', [app.request, adminA.subject]));
    });

    it('a rejection records its reason and grants nothing', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      expect(await decide(ownerA, clinicA, app.request, false, 'credentials_not_verified')).toMatchObject({ status: 'rejected', membershipId: null, decisionReason: 'credentials_not_verified', duplicate: false });
      expect(await decisions(app.request)).toEqual([{ action: 'rejected', reason_code: 'credentials_not_verified' }]);
      expect(await admitted(app.subject, clinicA)).toBe(false);
      expect(await status(app.subject)).toEqual([expect.objectContaining({ status: 'rejected', decisionReason: 'credentials_not_verified', clinicalAccess: null })]);
    });

    it('the queue shows the selected clinic\'s join requests and never who applied', async () => {
      const mine = await submit(randomUUID(), 'join', clinicA);
      const theirs = await submit(randomUUID(), 'join', clinicB);
      const queue = await list(adminA, clinicA);
      const ids = queue.map(entry => entry.id);
      expect(ids).toContain(mine.request);
      expect(ids).not.toContain(theirs.request);
      for (const entry of queue) expect(Object.keys(entry).sort()).toEqual(['createdAt', 'decidedAt', 'decisionReason', 'id', 'membershipId', 'status']);
      const text = JSON.stringify(queue);
      expect(text).not.toContain(mine.subject);
      expect(text).not.toContain(digest(mine.email));
      expect(text).not.toContain('@');
      expect((await list(ownerB, clinicB)).map(entry => entry.id)).toContain(theirs.request);
      expect(await refusal(list(practitionerA, clinicA))).toEqual({ code: '42501', message: 'organization_admin_required' });
      expect(await refusal(list(adminAB, clinicB))).toEqual({ code: '42501', message: 'organization_admin_required' });
    });
  });

  describe('retries, both race orders, and a decision that changed hands', () => {
    it('two administrators approving: the second answers the stored decision and writes nothing', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const first = await decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email));
      const second = await decide(ownerA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email));
      expect(second).toEqual({ ...first, duplicate: true });
      expect(await row(app.request)).toMatchObject({ reviewer_person_id: adminA.person });
      expect(await decisions(app.request)).toHaveLength(1);
    });

    it('approve then reject, and reject then approve: whichever commits first stands, and the other is a conflict', async () => {
      const one = await submit(randomUUID(), 'join', clinicA), two = await submit(randomUUID(), 'join', clinicA);
      await decide(adminA, clinicA, one.request, true, 'identity_confirmed_by_clinic', digest(one.email));
      expect(await refusal(decide(ownerA, clinicA, one.request, false, 'not_known_to_clinic'))).toEqual({ code: '22023', message: 'workforce_review_conflict' });
      await decide(ownerA, clinicA, two.request, false, 'not_known_to_clinic');
      expect(await refusal(decide(adminA, clinicA, two.request, true, 'identity_confirmed_by_clinic', digest(two.email)))).toEqual({ code: '22023', message: 'workforce_review_conflict' });
      expect(await row(one.request)).toMatchObject({ status: 'approved' });
      expect(await row(two.request)).toMatchObject({ status: 'rejected', approved_membership_id: null });
      expect(await admitted(two.subject, clinicA)).toBe(false);
    });

    it('an administrator demoted or suspended after reading the queue cannot decide from it', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const reader = actor(clinicA, 'admin.demoted'); await person(reader, 'admin');
      expect((await list(reader, clinicA)).map(entry => entry.id)).toContain(app.request);
      await asAdmin(ownerA, clinicA, async tx => {
        const id = (await tx.query<{ id: string }>('select id from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicA, reader.person])).rows[0]!.id;
        await tx.query("select clinical_core.set_org_member_role($1,'practitioner')", [id]);
      });
      expect(await refusal(decide(reader, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email)))).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
      const suspended = actor(clinicA, 'admin.suspended'); await person(suspended, 'admin');
      expect((await list(suspended, clinicA)).map(entry => entry.id)).toContain(app.request);
      await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [clinicA, suspended.person]);
      expect(String((await refusal(decide(suspended, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email)))).message)).toBe('workforce_membership_refused');
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
      expect(await decisions(app.request)).toEqual([]);
    });

    it('a demotion inside the deciding transaction, after the setter bound, is seen by the decision', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const late = actor(clinicA, 'admin.late'); await person(late, 'admin');
      const answer = await refusal(asAdmin(late, clinicA, async tx => {
        await tx.exec('reset role');
        await tx.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2", [clinicA, late.person]);
        await tx.exec('set local role clinical_core_api');
        return json(tx, 'select clinical_core.review_workforce_join_request_v2($1,true,$2,$3) as r', [app.request, 'identity_confirmed_by_clinic', digest(app.email)]);
      }));
      expect(answer).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
    });
  });

  describe('revocation', () => {
    it('is reasoned, audited, fences the next request, and a replayed approval does not restore access', async () => {
      const app = await submit(randomUUID(), 'join', clinicA);
      const approved = await decide(adminA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email));
      expect(await admitted(app.subject, clinicA)).toBe(true);
      expect(await refusal(revoke(adminA, clinicA, approved.membershipId as string, 'because'))).toEqual({ code: '22023', message: 'workforce_revocation_invalid' });
      expect(await refusal(revoke(practitionerA, clinicA, approved.membershipId as string, 'left_clinic'))).toEqual({ code: '42501', message: 'organization_admin_required' });
      expect(await revoke(adminA, clinicA, approved.membershipId as string, 'left_clinic')).toEqual({ membershipId: approved.membershipId, status: 'suspended', reason: 'left_clinic', duplicate: false });
      expect(await revoke(ownerA, clinicA, approved.membershipId as string, 'security_concern')).toMatchObject({ duplicate: true });
      const ledger = (await db.query<{ reason_code: string; reviewer_person_id: string }>('select reason_code,reviewer_person_id from clinical_private.workforce_membership_revocations where membership_id=$1', [approved.membershipId])).rows;
      expect(ledger).toEqual([{ reason_code: 'left_clinic', reviewer_person_id: adminA.person }]);
      const audit = (await db.query<{ n: number }>("select count(*)::int as n from clinical_audit.events where action='membership.suspended' and resource_id=$1", [approved.membershipId])).rows[0]!.n;
      expect(audit).toBe(1);
      // The token the practitioner already holds is irrelevant: every gated request asks the setter, which reads rows.
      expect(await admitted(app.subject, clinicA)).toBe(false);
      expect(await decide(ownerA, clinicA, app.request, true, 'identity_confirmed_by_clinic', digest(app.email))).toMatchObject({ duplicate: true, status: 'approved' });
      expect(await membership(approved.membershipId)).toEqual({ role: 'practitioner', status: 'suspended' });
      expect(await admitted(app.subject, clinicA)).toBe(false);
      expect(await status(app.subject)).toEqual([expect.objectContaining({ status: 'approved', clinicalAccess: 'not_available' })]);
    });

    it('refuses self-revocation and another clinic\'s membership', async () => {
      const own = (await db.query<{ id: string }>('select id from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicA, adminA.person])).rows[0]!.id;
      expect(await refusal(revoke(adminA, clinicA, own, 'left_clinic'))).toEqual({ code: '22023', message: 'self_suspension_refused' });
      const foreign = (await db.query<{ id: string }>('select id from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicB, ownerB.person])).rows[0]!.id;
      expect(await refusal(revoke(adminA, clinicA, foreign, 'left_clinic'))).toEqual({ code: 'P0002', message: 'membership_not_found' });
      expect(await admitted(ownerB.subject, clinicB)).toBe(true);
    });
  });

  describe('a platform operator reviews a new-clinic proposal, and the review grants nothing clinical', () => {
    const operator = randomUUID(), disabled = randomUUID();
    beforeAll(async () => { await registerOperator(operator); await registerOperator(disabled, 'disabled'); });

    it('refuses an unregistered or disabled operator, and an operator who is the applicant by subject or by email', async () => {
      const applicant = actor(clinicB, 'proposer');
      // A second workforce account, another person, holding the applicant's verified email address.
      const second = { ...actor(clinicB, 'proposer.second'), email: applicant.email };
      await person(second, null);
      await registerOperator(applicant.subject); await registerOperator(second.subject);
      const app = await submit(applicant.subject, 'create_clinic', 'FICTIONAL PROPOSED CLINIC R', applicant.email);
      expect(await refusal(decideProposal(randomUUID(), app.request, true, 'clinic_proposal_verified'))).toEqual({ code: '42501', message: 'workforce_operator_refused' });
      expect(await refusal(decideProposal(disabled, app.request, true, 'clinic_proposal_verified'))).toEqual({ code: '42501', message: 'workforce_operator_refused' });
      expect(await refusal(decideProposal(applicant.subject, app.request, true, 'clinic_proposal_verified'))).toEqual({ code: '42501', message: 'workforce_self_approval_refused' });
      expect(await refusal(decideProposal(second.subject, app.request, true, 'clinic_proposal_verified'))).toEqual({ code: '42501', message: 'workforce_self_approval_refused' });
      expect(await refusal(decideProposal(operator, app.request, true, 'identity_confirmed_by_clinic'))).toEqual({ code: '22023', message: 'workforce_review_invalid' });
      expect(await refusal(decideProposal(operator, randomUUID(), true, 'clinic_proposal_verified'))).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
      expect(await row(app.request)).toMatchObject({ status: 'pending' });
      await decideProposal(operator, app.request, false, 'duplicate_request');
    });

    it('an approved proposal creates the clinic and a held, pending owner membership: no route, no self-activation', async () => {
      const applicant = randomUUID();
      const app = await submit(applicant, 'create_clinic', 'FICTIONAL PROPOSED CLINIC S');
      const result = await decideProposal(operator, app.request, true, 'clinic_proposal_verified');
      expect(result).toMatchObject({ status: 'approved', activation: 'held', decisionReason: 'clinic_proposal_verified', duplicate: false });
      const clinic = result.organizationId as string;
      expect(await membership(result.membershipId)).toEqual({ role: 'owner', status: 'pending' });
      expect(await row(app.request)).toMatchObject({ operator_subject: operator, decision_reason: 'clinic_proposal_verified' });
      expect(await decisions(app.request)).toEqual([{ action: 'approved', reason_code: 'clinic_proposal_verified' }]);
      expect(await admitted(applicant, clinic)).toBe(false);
      const personId = (await db.query<{ person_id: string }>("select person_id from clinical_core.identities where identity_pool='workforce' and identity_subject=$1", [applicant])).rows[0]!.person_id;
      // Even with the legacy claim context the pilot path would build for this person and clinic, nothing turns it on.
      const activated = await db.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [personId, clinic, applicant]);
        const count = (await tx.query<{ n: number }>('select clinical_core.activate_my_memberships() as n')).rows[0]!.n;
        const role = (await tx.query<{ ok: boolean }>('select clinical_private.has_clinical_role($1) as ok', [clinic])).rows[0]!.ok;
        return { count, role };
      });
      expect(activated).toEqual({ count: 0, role: false });
      expect(await membership(result.membershipId)).toEqual({ role: 'owner', status: 'pending' });
      expect(await status(applicant)).toEqual([expect.objectContaining({ kind: 'create_clinic', status: 'approved', clinicalAccess: 'held_for_clinic_activation' })]);
      // The held owner cannot administer the clinic either: no join request to it can be decided.
      expect(String((await refusal(list({ person: personId, subject: applicant, org: clinic, email: '' }, clinic))).message)).toBe('workforce_membership_refused');
      // A replay answers the stored decision; a reversal is a conflict; nothing new is written.
      expect(await decideProposal(operator, app.request, true, 'clinic_proposal_verified')).toEqual({ ...result, duplicate: true });
      expect(await refusal(decideProposal(operator, app.request, false, 'clinic_proposal_declined'))).toEqual({ code: '22023', message: 'workforce_review_conflict' });
      expect((await db.query<{ n: number }>('select count(*)::int as n from clinical_core.organizations where organization_label=$1', ['FICTIONAL PROPOSED CLINIC S'])).rows[0]!.n).toBe(1);
    });

    it('the operator\'s queue lists proposals by name and decision, never by applicant, and only for a registered operator', async () => {
      const subject = randomUUID();
      const app = await submit(subject, 'create_clinic', 'FICTIONAL PROPOSED CLINIC T');
      const queue = await asRole('clinical_workforce_operator', async tx =>
        (await tx.query<{ r: Array<Record<string, unknown>> }>('select clinical_private.list_workforce_clinic_proposals($1) as r', [operator])).rows[0]!.r);
      expect(queue.find(entry => entry.id === app.request)).toMatchObject({ status: 'pending', proposedLabel: 'FICTIONAL PROPOSED CLINIC T', decisionReason: null });
      for (const entry of queue) expect(Object.keys(entry).sort()).toEqual(['createdAt', 'decidedAt', 'decisionReason', 'id', 'proposedLabel', 'status']);
      expect(JSON.stringify(queue)).not.toContain(subject);
      expect(JSON.stringify(queue)).not.toContain(digest(app.email));
      for (const who of [randomUUID(), disabled]) {
        expect(await refusal(asRole('clinical_workforce_operator', tx => tx.query('select clinical_private.list_workforce_clinic_proposals($1)', [who]))))
          .toEqual({ code: '42501', message: 'workforce_operator_refused' });
      }
    });

    it('a pending invitation elsewhere still self-activates: the hold is specific to held clinics', async () => {
      const invited = actor(clinicA, 'invited'); await person(invited, null);
      await asAdmin(ownerA, clinicA, tx => tx.query("select clinical_core.add_org_member($1,$2,'practitioner')", [clinicA, invited.email]));
      const count = await db.transaction(async tx => {
        await tx.exec('set local role clinical_core_api');
        await tx.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [invited.person, clinicA, invited.subject]);
        return (await tx.query<{ n: number }>('select clinical_core.activate_my_memberships() as n')).rows[0]!.n;
      });
      expect(count).toBe(1);
    });
  });

  describe('the applicant\'s own status', () => {
    it('reports pending, withdrawn and the clinic\'s decision, and nothing about anyone else', async () => {
      const subject = randomUUID();
      const first = await submit(subject, 'join', clinicA);
      expect(await status(subject)).toEqual([expect.objectContaining({ id: first.request, status: 'pending', clinicalAccess: null, decisionReason: null })]);
      await asRole('clinical_workforce_application', tx => tx.query('select clinical_private.withdraw_workforce_access_request($1,$2)', [first.request, subject]));
      const entries = await status(subject);
      expect(entries).toEqual([expect.objectContaining({ status: 'withdrawn', clinicalAccess: null })]);
      for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(['clinicalAccess', 'createdAt', 'decisionReason', 'id', 'kind', 'organizationId', 'status']);
      expect(await status(randomUUID())).toEqual([]);
    });

    it('reports not_available when the approved clinic is suspended, and available again only when current rows say so', async () => {
      const clinic = randomUUID();
      await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC C')", [clinic]);
      const owner = actor(clinic, 'owner.c'); await person(owner, 'owner');
      const app = await submit(randomUUID(), 'join', clinic);
      await decide(owner, clinic, app.request, true, 'identity_confirmed_by_clinic', digest(app.email));
      expect(await status(app.subject)).toEqual([expect.objectContaining({ clinicalAccess: 'available' })]);
      await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinic]);
      expect(await status(app.subject)).toEqual([expect.objectContaining({ clinicalAccess: 'not_available' })]);
      expect(await admitted(app.subject, clinic)).toBe(false);
      await db.query("update clinical_core.organizations set status='active' where id=$1", [clinic]);
      expect(await status(app.subject)).toEqual([expect.objectContaining({ clinicalAccess: 'available' })]);
    });
  });

  describe('rollback', () => {
    it('refuses while a held clinic exists, then restores the parents and keeps every recorded decision', async () => {
      const recorded = (await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_access_requests where decision_reason is not null')).rows[0]!.n;
      expect(recorded).toBeGreaterThan(0);
      await expect(exec(ROLLBACK)).rejects.toThrow(/workforce_rollback_refused_held_clinics/);
      expect(await functionDef(SIGNATURES.join)).not.toBeNull();
      // The owner decides each held clinic first; here every held owner membership is suspended, then the holds go.
      await db.query("update clinical_core.organization_memberships set status='suspended' where id in (select membership_id from clinical_private.workforce_clinic_activation_holds)");
      await db.query('delete from clinical_private.workforce_clinic_activation_holds');
      await exec(ROLLBACK);
      for (const signature of [SIGNATURES.activate, SIGNATURES.status, SIGNATURES.parentJoin, SIGNATURES.parentProposal]) expect(await functionDef(signature)).toBe(parentDefinitions[signature]);
      for (const signature of [SIGNATURES.list, SIGNATURES.join, SIGNATURES.proposal, SIGNATURES.revoke, SIGNATURES.proposals]) expect(await functionDef(signature)).toBeNull();
      expect(await canExecute('clinical_core_api', SIGNATURES.parentJoin)).toBe(true);
      expect(await canExecute('clinical_workforce_operator', SIGNATURES.parentProposal)).toBe(true);
      expect((await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_access_requests where decision_reason is not null')).rows[0]!.n).toBe(recorded);
      expect((await db.query<{ n: number }>('select count(*)::int as n from clinical_private.workforce_membership_revocations')).rows[0]!.n).toBeGreaterThan(0);
      expect((await db.query<{ t: string | null }>("select to_regclass('clinical_private.workforce_clinic_activation_holds')::text as t")).rows[0]!.t).toBeNull();
    });
  });
});
