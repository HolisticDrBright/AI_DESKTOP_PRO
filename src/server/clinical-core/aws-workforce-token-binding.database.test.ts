import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql';
const subject = randomUUID();
const person = randomUUID();
const organization = randomUUID();
const secondOrganization = randomUUID();
let db: PGlite;

const lookup = async (value: string) => {
  const result = await db.transaction(async (tx) => {
    await tx.exec('set local role clinical_token_binding');
    return tx.query<{ binding: Record<string, unknown> | null }>(
      'select clinical_private.workforce_token_binding_for_subject($1) as binding',
      [value],
    );
  });
  return result.rows[0]?.binding ?? null;
};

beforeAll(async () => {
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs', '--json',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((migration: { file: string }) =>
    migration.file.includes('workforce_token_binding'))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(CANDIDATE, 'utf8'));
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC'),($2,'FICTIONAL SECOND CLINIC')", [organization, secondOrganization]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, `subject_${person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [organization, person]);
}, 120_000);

afterAll(async () => { await db?.close(); });

describe('unregistered workforce token binding lookup', () => {
  it('has a dedicated non-login role and grants neither table reads nor execution to the clinical API', async () => {
    const { rows } = await db.query<{
      login: boolean; inherit: boolean; apiExecute: boolean; bindingExecute: boolean; tableRead: boolean;
    }>(`select role.rolcanlogin as login, role.rolinherit as inherit,
       has_function_privilege('clinical_core_api', 'clinical_private.workforce_token_binding_for_subject(text)', 'EXECUTE') as "apiExecute",
       has_function_privilege('clinical_token_binding', 'clinical_private.workforce_token_binding_for_subject(text)', 'EXECUTE') as "bindingExecute",
       has_table_privilege('clinical_token_binding', 'clinical_core.identities', 'SELECT') as "tableRead"
       from pg_roles role where role.rolname='clinical_token_binding'`);
    expect(rows[0]).toEqual({ login: false, inherit: false, apiExecute: false, bindingExecute: true, tableRead: false });
    await expect(db.transaction(async (tx) => {
      await tx.exec('set local role clinical_core_api');
      return tx.query('select clinical_private.workforce_token_binding_for_subject($1)', [subject]);
    })).rejects.toThrow(/permission denied/);
  });

  it('requires an exact active production-bound workforce identity and one active clinic', async () => {
    expect(await lookup(subject)).toEqual({
      subject, identityPool: 'workforce', personId: person, organizationId: organization,
      identityStatus: 'active', personStatus: 'active', organizationStatus: 'active',
      membershipStatus: 'active', activeMembershipCount: 1, productionBound: true,
    });
    expect(await lookup(randomUUID())).toBeNull();
    expect(await lookup(`prefix-${subject}`)).toBeNull();
    expect(await lookup('invalid')).toBeNull();

    // The same sub in the consumer pool must not be mistaken for this workforce identity.
    const consumer = randomUUID();
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [consumer, `subject_${consumer.replaceAll('-', '')}`]);
    await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'consumer',$2,true)", [consumer, subject]);
    expect((await lookup(subject))?.personId).toBe(person);
  });

  it('refuses disabled identity, disabled person, suspended clinic, absent membership and multiple clinics', async () => {
    await db.query("update clinical_core.identities set status='disabled' where identity_subject=$1", [subject]);
    expect(await lookup(subject)).toBeNull();
    await db.query("update clinical_core.identities set status='active' where identity_subject=$1", [subject]);
    await db.query("update clinical_core.persons set status='disabled' where id=$1", [person]);
    expect(await lookup(subject)).toBeNull();
    await db.query("update clinical_core.persons set status='active' where id=$1", [person]);
    await db.query("update clinical_core.organizations set status='suspended' where id=$1", [organization]);
    expect(await lookup(subject)).toBeNull();
    await db.query("update clinical_core.organizations set status='active' where id=$1", [organization]);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1", [organization]);
    expect(await lookup(subject)).toBeNull();
    await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1", [organization]);
    await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [secondOrganization, person]);
    expect(await lookup(subject)).toBeNull();
  });
});
