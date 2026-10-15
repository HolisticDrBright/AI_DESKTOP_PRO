import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitPostgresStatements } from './migrations';

const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql';
const TOKEN_LOOKUP = 'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql';
const clinic = randomUUID();
const admin = randomUUID();
const adminSub = randomUUID();
const emailHash = (value: string) => createHash('sha256').update(value).digest('hex');
let db: PGlite;

async function asRole<T>(role: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return work(tx);
  });
}

const submit = (request: string, subject: string, kind: 'join' | 'create_clinic',
  target: string | null, label: string | null, digest = emailHash(`${subject}@example.invalid`)) =>
  asRole('clinical_workforce_application', async (tx) =>
    (await tx.query<{ id: string }>(
      'select clinical_private.submit_workforce_access_request($1,$2,$3,$4,$5,$6) as id',
      [request, subject, digest, kind, target, label],
    )).rows[0]!.id);

const status = (subject: string) => asRole('clinical_workforce_application', async (tx) =>
  (await tx.query<{ state: Array<Record<string, unknown>> }>(
    'select clinical_private.workforce_access_status_for_subject($1) as state', [subject],
  )).rows[0]!.state);

const reviewJoin = (request: string, approve: boolean, person = admin, subject = adminSub,
  organization = clinic) => asRole('clinical_core_api', async (tx) => {
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
      person, organization, 'workforce', subject, 'clinical_data', 'production-clinical', 'clinical_phi',
    ]);
    return (await tx.query<{ result: Record<string, unknown> }>(
      'select clinical_core.review_workforce_join_request($1,$2) as result', [request, approve],
    )).rows[0]!.result;
  });

const reviewClinic = (request: string, approve: boolean, operator = 'platform-operator-001') =>
  asRole('clinical_workforce_operator', async (tx) =>
    (await tx.query<{ result: Record<string, unknown> }>(
      'select clinical_private.review_workforce_clinic_proposal($1,$2,$3) as result',
      [request, approve, operator],
    )).rows[0]!.result);

const binding = (subject: string) => asRole('clinical_token_binding', async (tx) =>
  (await tx.query<{ result: Record<string, unknown> | null }>(
    'select clinical_private.workforce_token_binding_for_subject($1) as result', [subject],
  )).rows[0]!.result);

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs', '--json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((migration: { file: string }) =>
    migration.file.includes('workforce-clinic-approved-onboarding'))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(TOKEN_LOOKUP, 'utf8'));
  const statements = splitPostgresStatements(readFileSync(CANDIDATE, 'utf8'));
  for (const [index, statement] of statements.entries()) {
    try { await db.exec(statement); }
    catch (error) {
      const sqlError = error as { position?: string; detail?: string };
      throw new Error(`onboarding candidate statement ${index + 1} length ${statement.length} position ${sqlError.position ?? '?'}: ${String(error)} ${sqlError.detail ?? ''} tail=${statement.slice(-180)}`);
    }
  }
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL EXISTING CLINIC')", [clinic]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',
    [admin, `subject_${admin.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",
    [admin, adminSub]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'owner')",
    [clinic, admin]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('blocked clinic-approved workforce onboarding candidate', () => {
  it('separates applicant, clinic, operator and token-binding privileges', async () => {
    const { rows } = await db.query<Record<string, unknown>>(`select
      has_table_privilege('clinical_workforce_application','clinical_private.workforce_access_requests','SELECT') as app_read,
      has_function_privilege('clinical_core_api','clinical_private.submit_workforce_access_request(uuid,text,text,text,uuid,text)','EXECUTE') as api_submit,
      has_function_privilege('clinical_workforce_application','clinical_core.review_workforce_join_request(uuid,boolean)','EXECUTE') as app_review,
      has_function_privilege('clinical_workforce_operator','clinical_private.review_workforce_clinic_proposal(uuid,boolean,text)','EXECUTE') as operator_review,
      has_function_privilege('clinical_workforce_operator','clinical_core.review_workforce_join_request(uuid,boolean)','EXECUTE') as operator_join,
      has_function_privilege('clinical_token_binding','clinical_private.submit_workforce_access_request(uuid,text,text,text,uuid,text)','EXECUTE') as token_submit`);
    expect(rows[0]).toEqual({ app_read: false, api_submit: false, app_review: false,
      operator_review: true, operator_join: false, token_submit: false });
  });

  it('keeps a verified applicant unbound until an active clinic admin approves the exact request', async () => {
    const subject = randomUUID(), request = randomUUID();
    expect(await submit(request, subject, 'join', clinic, null)).toBe(request);
    expect(await submit(request, subject, 'join', clinic, null)).toBe(request);
    expect(await binding(subject)).toBeNull();
    expect(await status(subject)).toMatchObject([{ id: request, kind: 'join', status: 'pending' }]);
    await expect(submit(request, randomUUID(), 'join', clinic, null)).rejects.toThrow(/request_conflict/);
    await expect(submit(randomUUID(), subject, 'create_clinic', null, 'A Second Clinic')).rejects.toThrow(/already_pending/);
    const approved = await reviewJoin(request, true);
    expect(approved).toMatchObject({ status: 'approved', organizationId: clinic });
    expect(await reviewJoin(request, true)).toEqual(approved);
    expect((await binding(subject))?.organizationId).toBe(clinic);
    expect(await status(subject)).toMatchObject([{ id: request, status: 'approved' }]);
    await expect(reviewJoin(request, false)).rejects.toThrow(/review_conflict/);
    const { rows } = await db.query<{ count: number }>(
      'select count(*)::int as count from clinical_core.identities where identity_pool=$1 and identity_subject=$2',
      ['workforce', subject],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('refuses a foreign or removed admin, and a clinic application cannot be self-approved', async () => {
    const subject = randomUUID(), request = randomUUID(), outsider = randomUUID(), outsiderSub = randomUUID();
    await submit(request, subject, 'join', clinic, null);
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',
      [outsider, `subject_${outsider.replaceAll('-', '')}`]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",
      [outsider, outsiderSub]);
    await expect(reviewJoin(request, true, outsider, outsiderSub)).rejects.toThrow(/organization_admin_required/);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",
      [clinic, admin]);
    try {
      await expect(reviewJoin(request, true)).rejects.toThrow(/organization_admin_required/);
    } finally {
      await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2",
        [clinic, admin]);
    }
    expect(await binding(subject)).toBeNull();
  });

  it('rejects and withdraws without creating an identity, then permits a new request', async () => {
    const subject = randomUUID(), first = randomUUID(), second = randomUUID();
    await submit(first, subject, 'join', clinic, null);
    await asRole('clinical_workforce_application', (tx) => tx.query(
      'select clinical_private.withdraw_workforce_access_request($1,$2)', [first, subject],
    ));
    expect(await binding(subject)).toBeNull();
    await submit(second, subject, 'join', clinic, null);
    expect(await reviewJoin(second, false)).toMatchObject({ status: 'rejected' });
    expect(await binding(subject)).toBeNull();
    expect((await status(subject)).map((row) => row.status)).toEqual(['rejected', 'withdrawn']);
  });

  it('requires separate platform review for a new clinic and settles retries without duplicates', async () => {
    const subject = randomUUID(), request = randomUUID();
    await submit(request, subject, 'create_clinic', null, '  FICTIONAL NEW CLINIC  ');
    expect(await binding(subject)).toBeNull();
    await expect(reviewClinic(request, true, subject)).rejects.toThrow(/self_approval/);
    const approved = await reviewClinic(request, true);
    expect(approved).toMatchObject({ status: 'approved' });
    expect(approved.organizationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reviewClinic(request, true)).toEqual(approved);
    expect((await binding(subject))?.organizationId).toBe(approved.organizationId);
    const { rows } = await db.query<{ count: number }>(
      'select count(*)::int as count from clinical_core.organizations where id=$1 and organization_label=$2',
      [approved.organizationId, 'FICTIONAL NEW CLINIC'],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('withholds fresh token binding after membership removal; old-token request fencing is separate', async () => {
    const subject = randomUUID(), request = randomUUID();
    await submit(request, subject, 'join', clinic, null);
    await reviewJoin(request, true);
    expect(await binding(subject)).not.toBeNull();
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=(select person_id from clinical_core.identities where identity_pool='workforce' and identity_subject=$2)",
      [clinic, subject]);
    expect(await binding(subject)).toBeNull();
    expect(await reviewJoin(request, true)).toMatchObject({ status: 'approved' });
    expect(await binding(subject)).toBeNull();
  });

  it('never restores an old admin role through a new practitioner application', async () => {
    const subject = randomUUID();
    await submit(randomUUID(), subject, 'join', clinic, null);
    const prior = (await db.query<{ id: string }>(
      'select id from clinical_private.workforce_access_requests where identity_subject=$1', [subject],
    )).rows[0]!.id;
    await reviewJoin(prior, true);
    await db.query(`update clinical_core.organization_memberships
      set role='admin',status='suspended'
      where organization_id=$1 and person_id=(select person_id from clinical_core.identities
        where identity_pool='workforce' and identity_subject=$2)`, [clinic, subject]);
    const next = randomUUID();
    await submit(next, subject, 'join', clinic, null);
    await reviewJoin(next, true);
    const { rows } = await db.query<{ role: string; status: string }>(`select role,status
      from clinical_core.organization_memberships where organization_id=$1
        and person_id=(select person_id from clinical_core.identities
          where identity_pool='workforce' and identity_subject=$2)`, [clinic, subject]);
    expect(rows[0]).toEqual({ role: 'practitioner', status: 'active' });
  });
});
