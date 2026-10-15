import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';

/**
 * Clinic authority over a join request, on the integrated head: the 106-migration artifact, the token-binding lookup,
 * the clinic-approved onboarding candidate (the parent), the invitation repair, and the BLOCKED uniform-refusal
 * successor. Everything runs through the API role with a production request context, as the compatibility adapter
 * calls it. Two fictional clinics, fictional people, fictional subjects and addresses only.
 */
const PARENT = 'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql';
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal-rollback.sql';
const TOKEN_LOOKUP = 'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql';
const INVITATION_REPAIR = 'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql';
const sha = (file: string) => createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const emailHash = (value: string) => createHash('sha256').update(value).digest('hex');

type Actor = { person: string; subject: string; org: string };
const clinicA = randomUUID(), clinicB = randomUUID();
const actor = (org: string): Actor => ({ person: randomUUID(), subject: randomUUID(), org });
const ownerA = actor(clinicA), adminA = actor(clinicA), practitionerA = actor(clinicA), ownerB = actor(clinicB);
let db: PGlite;

async function exec(file: string) {
  for (const [index, statement] of splitPostgresStatements(readFileSync(file, 'utf8')).entries()) {
    try { await db.exec(statement); } catch (error) { throw new Error(`${file} statement ${index + 1}: ${String(error)}`); }
  }
}
async function person(who: Actor, role: string | null, email?: string) {
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [who.person, who.subject]);
  if (email) await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [who.person, who.subject, emailHash(email)]);
  if (role) await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,$3,'active')", [who.org, who.person, role]);
}
const asApi = <T>(who: Actor, work: (tx: Transaction) => Promise<T>) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [who.person, who.org, 'workforce', who.subject, 'clinical_data', 'production-clinical', 'clinical_phi']);
  return work(tx);
});
const review = (who: Actor, request: string, approve: boolean) => asApi(who, async tx =>
  (await tx.query<{ result: Record<string, unknown> }>('select clinical_core.review_workforce_join_request($1,$2) as result', [request, approve])).rows[0]!.result);
const refusal = async (work: Promise<unknown>) => {
  try { await work; } catch (error) { const e = error as { code?: string; message?: string }; return { code: e.code, message: e.message }; }
  throw new Error('expected a refusal');
};
const submit = (request: string, subject: string, org: string, email = `${subject}@applicant.fictional.example`) => db.transaction(async tx => {
  await tx.exec('set local role clinical_workforce_application');
  return (await tx.query<{ id: string }>('select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6) as id',
    [request, subject, emailHash(email), 'join', org, null])).rows[0]!.id;
});
const requestRow = async (request: string) => (await db.query<{ status: string; approved_membership_id: string | null }>(
  'select status,approved_membership_id from clinical_private.workforce_access_requests where id=$1', [request])).rows[0];
// Every request has its 'submitted' event; these count the review decisions written after it.
const decisions = async (request: string) => (await db.query<{ n: number }>("select count(*)::int as n from clinical_private.workforce_access_events where request_id=$1 and action<>'submitted'", [request])).rows[0]!.n;
const definition = async () => (await db.query<{ def: string }>("select pg_get_functiondef('clinical_core.review_workforce_join_request(uuid,boolean)'::regprocedure) as def")).rows[0]!.def;

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await exec(TOKEN_LOOKUP); await exec(PARENT); await exec(INVITATION_REPAIR);
  for (const [id, label] of [[clinicA, 'FICTIONAL CLINIC A'], [clinicB, 'FICTIONAL CLINIC B']]) await db.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [id, label]);
  await person(ownerA, 'owner', `owner.a.${ownerA.person}@clinic.fictional.example`); await person(adminA, 'admin');
  await person(practitionerA, 'practitioner'); await person(ownerB, 'owner');
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('the parent candidate: one question, three answers (the failing-before evidence)', () => {
  it('an unknown id, another clinic\'s owner and a same-clinic practitioner are refused three different ways', async () => {
    const request = randomUUID(); await submit(request, randomUUID(), clinicA);
    const unknown = await refusal(review(ownerB, randomUUID(), true));
    const foreign = await refusal(review(ownerB, request, true));
    const sameClinic = await refusal(review(practitionerA, request, true));
    expect(unknown).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
    expect(foreign).toEqual({ code: '42501', message: 'production_context_refused' });
    expect(sameClinic).toEqual({ code: '42501', message: 'organization_admin_required' });
    // So clinic B's owner learns that the id exists somewhere, which is what the successor closes.
    expect(foreign).not.toEqual(unknown);
  });
});

describe('the uniform-refusal successor', () => {
  let parentDefinition: string;
  beforeAll(async () => { parentDefinition = await definition(); await exec(SUCCESSOR); });

  it('answers an unknown id, another clinic\'s request and a non-administrator identically, and changes nothing', async () => {
    const request = randomUUID(); await submit(request, randomUUID(), clinicA);
    const answers = [await refusal(review(ownerB, randomUUID(), true)), await refusal(review(ownerB, request, true)),
      await refusal(review(ownerB, request, false)), await refusal(review(practitionerA, request, true)), await refusal(review(practitionerA, randomUUID(), false))];
    for (const answer of answers) expect(answer).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
    expect(await requestRow(request)).toEqual({ status: 'pending', approved_membership_id: null });
    expect(await decisions(request)).toBe(0);
  });

  it('an administrator of the request\'s clinic approves once; a replay returns the same decision and a reversal is refused', async () => {
    const request = randomUUID(), subject = randomUUID(); await submit(request, subject, clinicA);
    const approved = await review(adminA, request, true);
    expect(approved).toMatchObject({ status: 'approved', organizationId: clinicA });
    expect(await review(ownerA, request, true)).toEqual(approved);
    expect(await refusal(review(ownerA, request, false))).toEqual({ code: '22023', message: 'workforce_review_conflict' });
    const member = (await db.query<{ role: string; status: string }>('select role,status from clinical_core.organization_memberships where id=$1', [approved.membershipId])).rows[0];
    expect(member).toEqual({ role: 'practitioner', status: 'active' });
    expect(await decisions(request)).toBe(1);
  });

  it('a role change or suspension after the request was made fails closed with the same refusal, and nothing is written', async () => {
    const request = randomUUID(); await submit(request, randomUUID(), clinicA);
    const demoted = actor(clinicA); await person(demoted, 'admin');
    await db.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2", [clinicA, demoted.person]);
    expect(await refusal(review(demoted, request, true))).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
    const suspended = actor(clinicA); await person(suspended, 'owner');
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [clinicA, suspended.person]);
    expect(await refusal(review(suspended, request, true))).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
    expect(await requestRow(request)).toEqual({ status: 'pending', approved_membership_id: null });
  });

  it('an existing owner is never demoted: neither by approving their own join request nor by being invited again', async () => {
    const ownerEmail = `owner.a.${ownerA.person}@clinic.fictional.example`;
    const request = randomUUID(); await submit(request, ownerA.subject, clinicA, ownerEmail);
    expect(await refusal(review(adminA, request, true))).toEqual({ code: '22023', message: 'workforce_already_member' });
    await expect(asApi(adminA, tx => tx.query('select clinical_core.add_org_member($1,$2,$3)', [clinicA, ownerEmail, 'member']))).rejects.toThrow(/membership_exists/);
    const membership = (await db.query<{ role: string; status: string }>('select role,status from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicA, ownerA.person])).rows[0];
    expect(membership).toEqual({ role: 'owner', status: 'active' });
  });

  it('differs from the parent only at its start, keeps the API role as the only caller, and the rollback restores the parent exactly', async () => {
    const successorDefinition = await definition();
    expect(successorDefinition).not.toBe(parentDefinition);
    // From the parent's authority check onward, the two definitions are the same text.
    const tail = (def: string) => def.slice(def.indexOf('perform clinical_private.require_organization_admin(_request.requested_organization_id,false);'));
    expect(tail(parentDefinition).length).toBeGreaterThan(1000);
    expect(tail(successorDefinition)).toBe(tail(parentDefinition));
    const grants = (await db.query<{ grantee: string }>("select grantee from information_schema.routine_privileges where routine_schema='clinical_core' and routine_name='review_workforce_join_request' and privilege_type='EXECUTE' order by grantee")).rows.map(row => row.grantee);
    expect(grants).toContain('clinical_core_api');
    expect(grants).not.toContain('clinical_workforce_application');
    expect(grants).not.toContain('clinical_workforce_operator');
    expect(grants).not.toContain('PUBLIC');
    await exec(ROLLBACK);
    expect(await definition()).toBe(parentDefinition);
    // The parent's answers are back, so the rollback is a real rollback, not a second copy of the successor.
    expect(await refusal(review(ownerB, randomUUID(), true))).toEqual({ code: 'P0002', message: 'workforce_application_not_found' });
    const request = randomUUID(); await submit(request, randomUUID(), clinicA);
    expect(await refusal(review(ownerB, request, true))).toEqual({ code: '42501', message: 'production_context_refused' });
    await exec(SUCCESSOR);
  });

  it('is pinned: the successor and its rollback are the reviewed bytes, and the parent is the candidate it was built on', () => {
    expect(sha(PARENT)).toBe('6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628');
    expect(readFileSync(SUCCESSOR, 'utf8')).toContain('6ed75111bb58c11ad3741b2d96d200d4af7f018735224354454b23ddaacf3628');
    expect({ successor: sha(SUCCESSOR), rollback: sha(ROLLBACK) }).toEqual({ successor: '7086b1a90db8cac47120a9d2be54f91f966b24e264351d3a247be838c872ee29', rollback: 'fc84894d7376d17db1290404e151b5d62fa99a1266727b0a3c9238fdbdc9698c' });
  });
});
