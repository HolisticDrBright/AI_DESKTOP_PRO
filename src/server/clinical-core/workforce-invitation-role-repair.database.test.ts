import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The workforce invitation path never changes an existing membership: the BLOCKED repair over the actual 106-migration
 * artifact, through the API role. The artifact's own function (restored by the rollback inside an undone transaction)
 * shows the defect first. Fictional people, clinics and addresses only.
 */
const CANDIDATE = 'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql';
const ROLLBACK = 'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair-rollback.sql';
let db: PGlite, clinic: string, owner: string, admin: string, invitee: string, OWNER_EMAIL: string, INVITEE_EMAIL: string;
const subject = (id: string) => 'fictional-' + id;
async function asAdmin<T = Record<string, unknown>>(sql: string, params: unknown[], options: { rollback?: boolean } = {}): Promise<T[]> {
  return db.transaction(async tx => {
    if (options.rollback) await tx.exec(readFileSync(ROLLBACK, 'utf8'));
    await tx.exec('set local role clinical_core_api');
    await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [admin, clinic, 'workforce', subject(admin), 'clinical_data', 'production-clinical', 'clinical_phi']);
    const rows = (await tx.query<T>(sql, params)).rows;
    if (options.rollback) {
      const after = (await tx.query<T>('select role,status from clinical_core.organization_memberships where organization_id=$1 order by person_id', [clinic])).rows;
      await tx.rollback();
      return after;
    }
    return rows;
  });
}
const invite = (email: string, role: string, options?: { rollback?: boolean }) => asAdmin('select clinical_core.add_org_member($1,$2,$3) as id', [clinic, email, role], options);
const membership = async (person: string) => (await db.query<{ role: string; status: string }>(
  'select role,status from clinical_core.organization_memberships where organization_id=$1 and person_id=$2', [clinic, person])).rows[0];

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations).toHaveLength(106);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(CANDIDATE, 'utf8'));
}, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  [clinic, owner, admin, invitee] = Array.from({ length: 4 }, () => randomUUID());
  OWNER_EMAIL = `owner.${owner}@clinic.fictional.example`; INVITEE_EMAIL = `invitee.${invitee}@clinic.fictional.example`;
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC')", [clinic]);
  for (const person of [owner, admin, invitee]) {
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, 'subject_' + person.replaceAll('-', '')]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject(person)]);
  }
  for (const [person, email] of [[owner, OWNER_EMAIL], [invitee, INVITEE_EMAIL]] as const)
    await db.query('insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values($1,$2,$3)',
      [person, subject(person), createHash('sha256').update(email).digest('hex')]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'owner','active'),($1,$3,'admin','active')", [clinic, owner, admin]);
});

describe('an invitation never changes an existing membership', () => {
  it('the artifact’s own function lets an admin demote the owner by re-inviting them (the defect, before the repair)', async () => {
    const after = await invite(OWNER_EMAIL, 'member', { rollback: true });
    expect(after).toContainEqual({ role: 'member', status: 'active' });
    // The undone transaction left the owner as they were.
    expect(await membership(owner)).toEqual({ role: 'owner', status: 'active' });
  });
  it('the repaired function refuses, and the owner stays the owner', async () => {
    await expect(invite(OWNER_EMAIL, 'member')).rejects.toThrow(/membership_exists/);
    expect(await membership(owner)).toEqual({ role: 'owner', status: 'active' });
  });
  it('a suspended member is not reinstated, nor their role changed, by being invited again', async () => {
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'practitioner','suspended')", [clinic, invitee]);
    await expect(invite(INVITEE_EMAIL, 'admin')).rejects.toThrow(/membership_exists/);
    expect(await membership(invitee)).toEqual({ role: 'practitioner', status: 'suspended' });
  });
  it('a first invitation works as before: one pending membership and one audit event', async () => {
    const [row] = await invite(INVITEE_EMAIL, 'practitioner');
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await membership(invitee)).toEqual({ role: 'practitioner', status: 'pending' });
    const [audit] = (await db.query<{ n: number }>("select count(*)::int as n from clinical_audit.events where resource_id=$1 and safe_metadata->>'event'='invited'", [row!.id])).rows;
    expect(audit!.n).toBe(1);
  });
  it('differs from the artifact only in its conflict clause, and keeps the API grant', async () => {
    const strip = (text: string) => text.slice(text.indexOf('create or replace function clinical_core.add_org_member(')).replace(/\s+/g, ' ');
    const candidate = strip(readFileSync(CANDIDATE, 'utf8')), original = strip(readFileSync(ROLLBACK, 'utf8'));
    const before = original.slice(0, original.indexOf('insert into clinical_core.organization_memberships'));
    expect(candidate.startsWith(before)).toBe(true);
    const [grant] = (await db.query<{ allowed: boolean }>("select has_function_privilege('clinical_core_api','clinical_core.add_org_member(uuid,text,text)','execute') as allowed")).rows;
    expect(grant!.allowed).toBe(true);
  });
});
