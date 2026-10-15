import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';
import type { ClinicalCoreDatabase } from './database';
import { reconcileWorkforceAccounts, type CognitoWorkforceUser } from './workforce-account-reconciliation';

/**
 * Existing-account and multi-clinic proof over the assembled schema, the onboarding parents, the setter and the BLOCKED
 * approval-authority candidate: the read-only reconciliation, two approved clinics selected in separate sessions, and an
 * already-issued token losing access after removal or demotion. The token is never consulted on the current-membership
 * path, so "an old token" here is a subject and a selected clinic, exactly what such a token supplies. Fictional only.
 */
const FILES = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const clinicA = randomUUID(), clinicB = randomUUID(), clinicSuspended = randomUUID();
let db: PGlite;
const statements: string[] = [];

type Person = { person: string; subject: string; email: string };
const make = (label: string): Person => { const person = randomUUID(); return { person, subject: randomUUID(), email: `${label}.${person.slice(0, 8)}@clinic.fictional.example` }; };
async function person(who: Person, memberships: Array<[string, string, string?]>, identityStatus = 'active') {
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [who.person, `subject_${who.person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound,status) values($1,'workforce',$2,true,$3)", [who.person, who.subject, identityStatus]);
  await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)', [who.person, who.subject, digest(who.email)]);
  for (const [org, role, status] of memberships) await db.query('insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,$3,$4)', [org, who.person, role, status ?? 'active']);
}
const user = (who: Person | { subject: string; email: string }, legacy: Partial<CognitoWorkforceUser['legacy']> = {}, extra: Partial<CognitoWorkforceUser> = {}): CognitoWorkforceUser => ({
  subject: who.subject, enabled: true, status: 'CONFIRMED', emailSha256: digest(who.email),
  legacy: { personId: null, organizationId: null, productionBound: null, ...legacy }, ...extra,
});
const reader: ClinicalCoreDatabase = {
  transaction: work => db.transaction(async (tx: Transaction) => work({ query: (sql, parameters = []) => { statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return tx.query(sql, parameters as unknown[]); } })),
};
/** What every gated clinical route asks: would current membership admit this subject to this clinic now? */
const admitted = (subject: string, clinic: string) => db.transaction(async tx => {
  await tx.exec('set local role clinical_core_api');
  return tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [subject, clinic]).then(() => true, () => false);
});
const fingerprint = async () => (await db.query<{ h: string }>(`select md5(string_agg(t,'|' order by t)) as h from (
  select 'p:'||p::text as t from clinical_core.persons p union all select 'i:'||i::text from clinical_core.identities i
  union all select 'm:'||m::text from clinical_core.organization_memberships m union all select 'o:'||o::text from clinical_core.organizations o
  union all select 'd:'||d::text from clinical_core.workforce_identity_directory d union all select 'r:'||r::text from clinical_private.workforce_access_requests r
  union all select 'e:'||e::text from clinical_private.workforce_access_events e) rows`)).rows[0]!.h;

const consistent = make('consistent'), twoClinics = make('two.clinics'), misbound = make('misbound'), removed = make('removed');
const disabledAccount = make('disabled.account'), disabledIdentity = make('disabled.identity'), demoted = make('demoted');
const suspendedClinic = make('suspended.clinic'), owner = make('owner');
const unbound = { subject: randomUUID(), email: 'unbound.applicant@applicant.fictional.example' };
const sharedOne = make('shared'), sharedTwo = { subject: randomUUID(), email: '' };
const users: CognitoWorkforceUser[] = [];

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  for (const file of FILES) for (const statement of splitPostgresStatements(readFileSync(file, 'utf8'))) await db.exec(statement);
  for (const [id, label] of [[clinicA, 'FICTIONAL CLINIC A'], [clinicB, 'FICTIONAL CLINIC B'], [clinicSuspended, 'FICTIONAL CLINIC S']]) await db.query('insert into clinical_core.organizations(id,organization_label) values($1,$2)', [id, label]);
  await person(owner, [[clinicA, 'owner'], [clinicB, 'owner'], [clinicSuspended, 'owner']]);
  await person(consistent, [[clinicA, 'practitioner']]);
  await person(twoClinics, [[clinicA, 'practitioner'], [clinicB, 'practitioner']]);
  await person(misbound, [[clinicA, 'practitioner']]);
  await person(removed, [[clinicA, 'practitioner', 'suspended']]);
  await person(disabledAccount, [[clinicA, 'practitioner']]);
  await person(disabledIdentity, [[clinicA, 'practitioner']], 'disabled');
  await person(demoted, [[clinicA, 'member']]);
  await person(suspendedClinic, [[clinicSuspended, 'practitioner']]);
  await person(sharedOne, [[clinicB, 'practitioner']]);
  sharedTwo.email = sharedOne.email;
  await db.query("update clinical_core.organizations set status='suspended' where id=$1", [clinicSuspended]);
  // A clinic proposal approved by a registered operator: a held, pending owner.
  const operator = randomUUID(), proposer = randomUUID();
  await db.query('insert into clinical_private.workforce_platform_operators(operator_subject) values($1)', [operator]);
  await db.transaction(async tx => {
    await tx.exec('set local role clinical_workforce_application');
    await tx.query("select clinical_private.submit_workforce_access_request($1,$2,$3,'create_clinic',null,'FICTIONAL HELD CLINIC')", [randomUUID(), proposer, digest('proposer@applicant.fictional.example')]);
  });
  const request = (await db.query<{ id: string }>('select id from clinical_private.workforce_access_requests where identity_subject=$1', [proposer])).rows[0]!.id;
  await db.transaction(async tx => {
    await tx.exec('set local role clinical_workforce_operator');
    await tx.query("select clinical_private.review_workforce_clinic_proposal_v2($1,true,$2,'clinic_proposal_verified')", [request, operator]);
  });
  users.push(
    user(consistent, { personId: consistent.person, organizationId: clinicA, productionBound: true }),
    user(twoClinics, { personId: twoClinics.person, organizationId: clinicA, productionBound: true }),
    user(misbound, { personId: randomUUID(), organizationId: clinicA, productionBound: true }),
    user(removed, { personId: removed.person, organizationId: clinicA, productionBound: true }),
    user(disabledAccount, { personId: disabledAccount.person, organizationId: clinicA }, { enabled: false }),
    user(disabledIdentity, { personId: disabledIdentity.person, organizationId: clinicA }),
    user(demoted, { personId: demoted.person, organizationId: clinicA }),
    user(suspendedClinic, { personId: suspendedClinic.person, organizationId: clinicSuspended }),
    user(unbound),
    user({ subject: randomUUID(), email: 'unconfirmed@applicant.fictional.example' }, {}, { status: 'UNCONFIRMED' }),
    user(sharedOne, { personId: sharedOne.person, organizationId: clinicB }),
    user(sharedTwo),
    user({ subject: proposer, email: 'proposer@applicant.fictional.example' }),
  );
}, 180_000);
afterAll(async () => { await db?.close(); });

describe('read-only reconciliation of existing workforce accounts', () => {
  it('reports each disagreement between Cognito, the binding, memberships and legacy claims', async () => {
    const report = await reconcileWorkforceAccounts(reader, users);
    const by = (subject: string) => report.subjects.find(entry => entry.subject === subject)!;
    expect(report.database).toBe('read');
    expect(by(consistent.subject)).toEqual({ subject: consistent.subject, outcome: 'consistent', personId: consistent.person, admittedClinics: [clinicA], findings: [] });
    expect(by(twoClinics.subject)).toMatchObject({ outcome: 'attention', findings: ['multiple_active_clinics'] });
    expect(by(twoClinics.subject).admittedClinics.sort()).toEqual([clinicA, clinicB].sort());
    expect(by(misbound.subject)).toMatchObject({ outcome: 'attention', findings: ['binding_ambiguous'] });
    expect(by(removed.subject)).toMatchObject({ outcome: 'attention', admittedClinics: [], findings: ['revoked_membership', 'stale_legacy_claim'] });
    expect(by(disabledAccount.subject)).toMatchObject({ outcome: 'attention', findings: ['disabled_account_with_membership'] });
    expect(by(disabledIdentity.subject)).toMatchObject({ outcome: 'attention', admittedClinics: [], findings: ['disabled_identity', 'stale_legacy_claim'] });
    expect(by(demoted.subject)).toMatchObject({ outcome: 'attention', admittedClinics: [], findings: ['stale_legacy_claim'] });
    expect(by(suspendedClinic.subject)).toMatchObject({ outcome: 'attention', admittedClinics: [], findings: ['stale_legacy_claim'] });
    expect(by(unbound.subject)).toMatchObject({ outcome: 'consistent', personId: null, admittedClinics: [], findings: ['unbound'] });
    expect(report.subjects.find(entry => entry.findings.includes('unconfirmed_account'))).toMatchObject({ admittedClinics: [] });
    expect(by(sharedOne.subject).findings).toContain('binding_ambiguous');
    expect(by(sharedTwo.subject).findings).toEqual(expect.arrayContaining(['binding_ambiguous', 'unbound']));
    expect(report.subjects.find(entry => entry.findings.includes('held_clinic'))).toMatchObject({ outcome: 'consistent', admittedClinics: [] });
    // The report carries ids and codes only: no address, no clinic name.
    expect(JSON.stringify(report)).not.toMatch(/@|FICTIONAL/);
  });

  it('changes nothing: one read-only transaction, reads only', async () => {
    const before = await fingerprint();
    statements.length = 0;
    await reconcileWorkforceAccounts(reader, users);
    expect(await fingerprint()).toBe(before);
    expect(statements[0]).toBe('set transaction read');
    expect(statements.slice(1).every(statement => statement.startsWith('select '))).toBe(true);
    // And the guard it relies on: a write after it is refused by the database.
    const refused = await db.transaction(async tx => { await tx.exec('set transaction read only'); return tx.query("update clinical_core.organizations set status='active'").then(() => 'written', error => (error as { code?: string }).code); });
    expect(refused).toBe('25006');
  });

  it('a database it cannot read makes every subject unknown, never consistent', async () => {
    const down: ClinicalCoreDatabase = { transaction: async () => { throw new Error('connection refused'); } };
    const report = await reconcileWorkforceAccounts(down, users);
    expect(report.database).toBe('unavailable');
    expect(report.subjects.every(entry => entry.outcome === 'unknown' && entry.findings.length === 0 && entry.admittedClinics.length === 0)).toBe(true);
    expect(report.totals).toMatchObject({ unknown: users.length, consistent: 0 });
  });

  it('refuses a malformed export rather than reconciling part of it', async () => {
    await expect(reconcileWorkforceAccounts(reader, [{ ...users[0]!, subject: 'not-a-subject' }])).rejects.toThrow('reconciliation_export_invalid');
  });
});

describe('two approved clinics, one login, separate sessions', () => {
  it('each session acts in its own selection, and the selection does not outlive its transaction', async () => {
    const inClinic = (clinic: string) => db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [twoClinics.subject, clinic]);
      return (await tx.query<{ org: string }>('select clinical_private.organization_id()::text as org')).rows[0]!.org;
    });
    expect(await inClinic(clinicA)).toBe(clinicA);
    expect(await inClinic(clinicB)).toBe(clinicB);
    expect(await inClinic(clinicA)).toBe(clinicA);
    // No global preference: outside a bound transaction there is no clinic at all.
    expect((await db.query<{ v: string | null }>("select nullif(current_setting('clinical.claim.organization_id',true),'') as v")).rows[0]!.v).toBeNull();
    // A clinic the login has no current membership in is not selectable by any session.
    expect(await admitted(twoClinics.subject, clinicSuspended)).toBe(false);
  });
});

describe('an already-issued token after removal or demotion', () => {
  it('loses clinical access at the next request, whatever the token still says', async () => {
    const practitioner = make('later.removed'), later = make('later.demoted');
    await person(practitioner, [[clinicA, 'practitioner']]);
    await person(later, [[clinicA, 'practitioner']]);
    expect(await admitted(practitioner.subject, clinicA)).toBe(true);
    expect(await admitted(later.subject, clinicA)).toBe(true);
    const membership = (who: Person) => db.query<{ id: string }>('select id from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinicA, who.person]).then(r => r.rows[0]!.id);
    const [removedId, demotedId] = [await membership(practitioner), await membership(later)];
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [owner.subject, clinicA]);
      await tx.query("select clinical_core.revoke_workforce_membership($1,'left_clinic')", [removedId]);
      await tx.query("select clinical_core.set_org_member_role($1,'member')", [demotedId]);
    });
    expect(await admitted(practitioner.subject, clinicA)).toBe(false);
    expect(await admitted(later.subject, clinicA)).toBe(false);
  });
});

describe('an unapproved account has no clinical access anywhere', () => {
  it('a direct sign-up, a pending applicant and a rejected one are admitted to no clinic', async () => {
    const pending = randomUUID(), rejected = randomUUID();
    for (const [subject, clinic] of [[pending, clinicA], [rejected, clinicA]] as const) {
      await db.transaction(async tx => {
        await tx.exec('set local role clinical_workforce_application');
        await tx.query("select clinical_private.submit_workforce_access_request($1,$2,$3,'join',$4,null)", [randomUUID(), subject, digest(`${subject}@applicant.fictional.example`), clinic]);
      });
    }
    const rejectedRequest = (await db.query<{ id: string }>('select id from clinical_private.workforce_access_requests where identity_subject=$1', [rejected])).rows[0]!.id;
    await db.transaction(async tx => {
      await tx.exec('set local role clinical_core_api');
      await tx.query("select clinical_private.set_current_workforce_context($1,$2,'clinical_data')", [owner.subject, clinicA]);
      await tx.query("select clinical_core.review_workforce_join_request_v2($1,false,'not_known_to_clinic',null)", [rejectedRequest]);
    });
    for (const subject of [unbound.subject, pending, rejected]) {
      for (const clinic of [clinicA, clinicB, clinicSuspended]) expect([subject, clinic, await admitted(subject, clinic)]).toEqual([subject, clinic, false]);
    }
    // And no person was created for them: nothing for a legacy claim to name either.
    expect((await db.query<{ n: number }>("select count(*)::int as n from clinical_core.identities where identity_pool='workforce' and identity_subject = any($1::text[])", [[unbound.subject, pending, rejected]])).rows[0]!.n).toBe(0);
  });
});
