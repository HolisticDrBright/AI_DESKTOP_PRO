import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAwsProductionDesktopAdapter, ProductionDesktopError } from './aws-production-desktop';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase } from './database';

const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';
const subject = randomUUID(), person = randomUUID(), first = randomUUID(), second = randomUUID();
const outsider = randomUUID(), outsiderSub = randomUUID(), foreign = randomUUID();
let db: PGlite;

async function context(who: string, clinic: string, purpose = 'clinical_data') {
  return db.transaction(async (tx) => {
    await tx.exec('set local role clinical_core_api');
    const { rows } = await tx.query<{ result: { personId: string; organizationId: string; role: string } }>(
      'select clinical_private.set_current_workforce_context($1,$2,$3) as result',
      [who,clinic,purpose],
    );
    const organizations = (await tx.query<{ organization_id: string }>(
      'select organization_id from clinical_core.list_my_organizations()',
    )).rows.map((row) => row.organization_id);
    return { binding: rows[0]!.result,organizations };
  });
}

beforeAll(async () => {
  const { manifest,files } = JSON.parse(execFileSync(process.execPath, [
    'scripts/build-aws-production-clinical-core.mjs','--json',
  ], { encoding: 'utf8',timeout: 20_000,maxBuffer: 8 * 1024 * 1024 }));
  expect(manifest.migrations.some((m: { file: string }) => m.file.includes('current-membership-context'))).toBe(false);
  db = new PGlite({ extensions: { pgcrypto } });
  for (const migration of manifest.migrations) await db.exec(files[migration.file]);
  await db.exec(readFileSync(CANDIDATE,'utf8'));
  await db.query(`insert into clinical_core.organizations(id,organization_label)
    values($1,'FICTIONAL FIRST'),($2,'FICTIONAL SECOND'),($3,'FICTIONAL FOREIGN')`,
  [first,second,foreign]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2),($3,$4)',
    [person,`subject_${person.replaceAll('-','')}`,outsider,`subject_${outsider.replaceAll('-','')}`]);
  await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound)
    values($1,'workforce',$2,true),($3,'workforce',$4,true)`,
  [person,subject,outsider,outsiderSub]);
  await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role)
    values($1,$2,'practitioner'),($3,$4,'practitioner')`,
  [first,person,foreign,outsider]);
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('unregistered current workforce membership context', () => {
  it('runs the Desktop operation under current membership in the same database transaction', async () => {
    let transactions = 0;
    const database: ClinicalCoreDatabase = {
      transaction: async (work) => {
        transactions += 1;
        try {
          return await db.transaction(async (tx) => {
            await tx.exec('set local role clinical_core_api');
            return work({ query: (sql,parameters = []) => tx.query(sql,parameters.map((value) =>
              value && typeof value === 'object' && 'kind' in value && value.kind === 'uuid'
                && 'value' in value && typeof value.value === 'string'
                ? value.value : value)) });
          });
        } catch (error) {
          if (String(error).includes('workforce_membership_refused')) {
            throw new ClinicalCoreDatabaseRejection('identity_refused');
          }
          throw error;
        }
      },
    };
    const adapter = createAwsProductionDesktopAdapter(database);
    const request = { kind: 'rpc' as const,functionName: 'list_my_organizations',args: {} };
    const principal = { subject,selectedOrganizationId: first };
    const result = await adapter.executeWithCurrentMembership!(principal,request);
    expect(result).toEqual([expect.objectContaining({ organization_id: first })]);
    expect(transactions).toBe(1);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2",
      [first,person]);
    try {
      await expect(adapter.executeWithCurrentMembership!(principal,request)).rejects.toMatchObject({
        category: 'identity_refused',name: ProductionDesktopError.name,
      });
    } finally {
      await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2",
        [first,person]);
    }
    expect(transactions).toBe(2);
  });

  it('resolves person, role and the explicitly selected clinic from current rows', async () => {
    expect((await context(subject,first)).binding).toEqual({
      personId: person,organizationId: first,role: 'practitioner',
    });
    expect((await context(subject,first)).organizations).toEqual([first]);
    await expect(context(subject,foreign)).rejects.toThrow(/workforce_membership_refused/);
    await expect(context(outsiderSub,first)).rejects.toThrow(/workforce_membership_refused/);
  });

  it('refuses an unapproved subject and a suspended membership even with the same old subject', async () => {
    const applicant = randomUUID(), applicantPerson = randomUUID();
    await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',
      [applicantPerson,`subject_${applicantPerson.replaceAll('-','')}`]);
    await db.query(`insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound)
      values($1,'workforce',$2,true)`, [applicantPerson,applicant]);
    await expect(context(applicant,first)).rejects.toThrow(/workforce_membership_refused/);
    await db.query(`update clinical_core.organization_memberships set status='suspended'
      where organization_id=$1 and person_id=$2`, [first,person]);
    try { await expect(context(subject,first)).rejects.toThrow(/workforce_membership_refused/); }
    finally { await db.query(`update clinical_core.organization_memberships set status='active'
      where organization_id=$1 and person_id=$2`, [first,person]); }
  });

  it('supports two approved clinics with an exact per-request selection, not a global current clinic', async () => {
    await db.query(`insert into clinical_core.organization_memberships(organization_id,person_id,role)
      values($1,$2,'staff')`, [second,person]);
    expect((await context(subject,first)).binding.organizationId).toBe(first);
    expect((await context(subject,second)).binding).toEqual({
      personId: person,organizationId: second,role: 'staff',
    });
    expect((await context(subject,first)).binding.organizationId).toBe(first);
  });

  it('does not treat a non-clinical member role as authority for the Desktop clinical route', async () => {
    await db.query("update clinical_core.organization_memberships set role='member' where organization_id=$1 and person_id=$2",
      [first,person]);
    try { await expect(context(subject,first)).rejects.toThrow(/workforce_membership_refused/); }
    finally {
      await db.query("update clinical_core.organization_memberships set role='practitioner' where organization_id=$1 and person_id=$2",
        [first,person]);
    }
  });

  it('refuses disabled identity, person and clinic at the transaction boundary', async () => {
    await db.query("update clinical_core.identities set status='disabled' where identity_subject=$1",[subject]);
    await expect(context(subject,first)).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.identities set status='active' where identity_subject=$1",[subject]);
    await db.query("update clinical_core.persons set status='disabled' where id=$1",[person]);
    await expect(context(subject,first)).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.persons set status='active' where id=$1",[person]);
    await db.query("update clinical_core.organizations set status='suspended' where id=$1",[first]);
    try { await expect(context(subject,first)).rejects.toThrow(/workforce_membership_refused/); }
    finally { await db.query("update clinical_core.organizations set status='active' where id=$1",[first]); }
  });

  it('grants the new setter to the API role but not to PUBLIC', async () => {
    const { rows } = await db.query<{ api: boolean; publicGrant: boolean }>(`select
      has_function_privilege('clinical_core_api',
        'clinical_private.set_current_workforce_context(text,uuid,text)','EXECUTE') as api,
      exists(select 1 from information_schema.routine_privileges
        where routine_schema='clinical_private' and routine_name='set_current_workforce_context'
          and grantee='PUBLIC' and privilege_type='EXECUTE') as "publicGrant"`);
    expect(rows[0]).toEqual({ api: true,publicGrant: false });
  });
});
