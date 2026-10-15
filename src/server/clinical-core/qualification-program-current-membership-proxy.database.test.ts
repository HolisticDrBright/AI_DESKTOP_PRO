import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyProductionClinicalCoreMigrations } from './production-migrations';
import type { ClinicalCoreDatabase } from './database';
import { bindQualificationProgramDatabase, QUALIFICATION_PROGRAM_FUNCTIONS,
  QUALIFICATION_CURRENT_MEMBERSHIP_PROXY_BODY_SHA256 } from './qualification-program-assignments';

// BLOCKED source rehearsal only. No SQL in this file is registered or applied to AWS.
const root = 'infra/aws-clinical-core/';
const parents = ['lab-result-transfer-v2.sql', 'lab-observation-attestation.sql',
  'production-program-assignments.sql', 'production-program-consumer-boundary.sql'].map(name => `${root}production-candidates/${name}`);
const boundary = `${root}source-candidates/qualification-program-boundary.sql`;
const login = `${root}source-candidates/qualification-program-api-login.sql`;
const setter = `${root}source-candidates/workforce-current-membership-context.sql`;
const candidate = `${root}source-candidates/qualification-program-current-membership-proxy.sql`;
const rollback = `${root}source-candidates/qualification-program-current-membership-proxy-rollback.sql`;
const lf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const signature = 'clinical_program_qualification.set_current_workforce_context(text,uuid,text)';
let db: PGlite, clinic: string, person: string, subject: string;

async function call(subjectValue = subject, clinicValue = clinic, purpose: string | null = 'clinical_data') {
  return db.transaction(async tx => {
    await tx.exec('set local role clinical_program_qualification_api');
    return tx.query<{ binding: { personId: string; organizationId: string; role: string } }>(
      'select clinical_program_qualification.set_current_workforce_context($1,$2,$3) as binding',
      [subjectValue, clinicValue, purpose]);
  });
}
async function refusedCandidate(sql: string, reason: RegExp) {
  try { await expect(db.exec(sql)).rejects.toThrow(reason); }
  finally { await db.exec('rollback'); }
}
const restrictedDatabase: ClinicalCoreDatabase = { transaction: work => db.transaction(async tx => {
  await tx.exec('set local role clinical_program_qualification_api');
  return work({ query: (sql, args = []) => tx.query(sql, [...args]) as never });
}) };
async function baseRouteBinding() {
  const functions = await Promise.all(QUALIFICATION_PROGRAM_FUNCTIONS.map(async ([name]) => {
    const [schema, routine] = name.split('.');
    const row = await db.query<{ body: string }>(`select p.prosrc as body from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2`, [schema, routine]);
    expect(row.rows).toHaveLength(1);
    return { name, bodySha256: sha(row.rows[0]!.body) };
  }));
  return bindQualificationProgramDatabase(restrictedDatabase, functions).transaction(tx => tx.query('select 1 as ok'));
}

beforeAll(async () => {
  const assembled = JSON.parse(execFileSync(process.execPath,
    ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }));
  db = new PGlite({ extensions: { pgcrypto } });
  const migrations = assembled.manifest.migrations.map((entry: { version: string; file: string }) => ({
    version: entry.version, name: entry.file.slice(15, -4), sql: assembled.files[entry.file], sha256: sha(assembled.files[entry.file]),
  }));
  const admin: ClinicalCoreDatabase = { transaction: work => db.transaction(tx => work({ query: (sql, args = []) => tx.query(sql, [...args]) as never })) };
  await applyProductionClinicalCoreMigrations(admin, migrations.slice(0, 106));
  for (const entry of migrations.slice(106)) {
    await db.exec(entry.sql);
    await db.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [entry.version, entry.name, entry.sha256]);
  }
  expect(migrations).toHaveLength(112);
  for (const file of parents) await db.exec(lf(file));
  await db.exec(lf(boundary));
  const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
  await db.exec(lf(login).replace("current_database() <> 'clinical_core_qualification'", `current_database() <> '${databaseName}'`));
  await db.exec(lf(setter));
  clinic = randomUUID(); person = randomUUID(); subject = randomUUID();
  await db.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL CLINIC')", [clinic]);
  await db.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [person, `subject_${person.replaceAll('-', '')}`]);
  await db.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [person, subject]);
  await db.query("insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values($1,$2,'practitioner','active')", [clinic, person]);
}, 240_000);
afterAll(async () => { await db?.close(); });

describe('blocked current-membership proxy for the restricted qualification login', () => {
  it('is unavailable before the candidate and direct clinical access remains denied', async () => {
    await expect(baseRouteBinding()).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    await expect(call()).rejects.toThrow();
    await expect(db.transaction(async tx => {
      await tx.exec('set local role clinical_program_qualification_api');
      await tx.query('select clinical_private.set_current_workforce_context($1,$2,$3)', [subject, clinic, 'clinical_data']);
    })).rejects.toThrow();
  });

  it('refuses a wrong database or changed parent before adding a proxy', async () => {
    await refusedCandidate(lf(candidate), /qualification_database_refused/);
    const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
    await db.exec("alter function clinical_private.set_current_workforce_context(text,uuid,text) set search_path=public");
    try {
      await refusedCandidate(lf(candidate).replace("current_database() <> 'clinical_core_qualification'",
        `current_database() <> '${databaseName}'`), /current_membership_setter_refused/);
    } finally {
      await db.exec("alter function clinical_private.set_current_workforce_context(text,uuid,text) set search_path=''");
    }
    await db.exec('alter function clinical_program_qualification.bounded_request(jsonb) set search_path=public');
    try {
      await refusedCandidate(lf(candidate).replace("current_database() <> 'clinical_core_qualification'",
        `current_database() <> '${databaseName}'`), /qualification_proxy_parent_refused/);
    } finally {
      await db.exec("alter function clinical_program_qualification.bounded_request(jsonb) set search_path=''");
    }
    await db.exec('grant clinical_core_api to clinical_program_qualification_api');
    try {
      await refusedCandidate(lf(candidate).replace("current_database() <> 'clinical_core_qualification'",
        `current_database() <> '${databaseName}'`), /qualification_role_refused/);
    } finally {
      await db.exec('revoke clinical_core_api from clinical_program_qualification_api');
    }
    expect((await db.query<{ oid: string | null }>('select to_regprocedure($1)::text as oid', [signature])).rows[0]?.oid).toBeNull();
  });

  it('adds only one narrow definer proxy and binds current fictional membership', async () => {
    const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
    await db.exec(lf(candidate).replace("current_database() <> 'clinical_core_qualification'", `current_database() <> '${databaseName}'`));
    const observed = await db.query<{ body: string; definer: boolean; config: string[]; api: boolean; everyone: boolean }>(`
      select p.prosrc as body,p.prosecdef as definer,p.proconfig as config,
        has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE') as api,
        has_function_privilege('public',p.oid,'EXECUTE') as everyone
      from pg_proc p where p.oid=to_regprocedure('${signature}')`);
    expect(observed.rows).toHaveLength(1);
    expect(observed.rows[0]).toMatchObject({ definer: true, config: ['search_path=""'], api: true, everyone: false });
    const body = lf(candidate).match(/create function clinical_program_qualification\.set_current_workforce_context\([\s\S]*?as \$\$([\s\S]*?)\$\$;/)?.[1];
    expect(body).toBeDefined();
    expect(sha(observed.rows[0]!.body)).toBe(sha(body!));
    expect(sha(body!)).toBe(QUALIFICATION_CURRENT_MEMBERSHIP_PROXY_BODY_SHA256);
    const bound = await call();
    expect(bound.rows[0]?.binding).toMatchObject({ personId: person, organizationId: clinic, role: 'practitioner' });
    expect((await db.query<{ clinical: boolean; private: boolean; member: boolean }>(`
      select has_schema_privilege('clinical_program_qualification_api','clinical_core','USAGE') as clinical,
        has_schema_privilege('clinical_program_qualification_api','clinical_private','USAGE') as private,
        pg_has_role('clinical_program_qualification_api','clinical_core_api','MEMBER') as member`)).rows[0])
      .toEqual({ clinical: false, private: false, member: false });
    expect((await db.query<{ count: number }>(`select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clinical_program_qualification'`)).rows[0]?.count).toBe(3);
    await expect(baseRouteBinding()).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('the compatible base route still refuses a changed optional proxy or any fourth function', async () => {
    await db.exec(`alter function ${signature} set search_path=public`);
    try { await expect(baseRouteBinding()).rejects.toThrow(); }
    finally { await db.exec(`alter function ${signature} set search_path=''`); }
    await db.exec(`grant execute on function ${signature} to clinical_core_api`);
    try { await expect(baseRouteBinding()).rejects.toThrow(); }
    finally { await db.exec(`revoke execute on function ${signature} from clinical_core_api`); }
    await db.exec("create function clinical_program_qualification.unreviewed_extra() returns int language plpgsql as $$ begin return 1; end $$");
    try { await expect(baseRouteBinding()).rejects.toThrow(); }
    finally { await db.exec('drop function clinical_program_qualification.unreviewed_extra()'); }
    await expect(baseRouteBinding()).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('refuses purpose expansion, foreign subjects, nonmembers and a removed membership', async () => {
    await expect(call(subject, clinic, 'identity_link')).rejects.toThrow(/workforce_membership_refused/);
    await expect(call(subject, clinic, null)).rejects.toThrow(/workforce_membership_refused/);
    await expect(call(randomUUID())).rejects.toThrow(/workforce_membership_refused/);
    await expect(call(subject, randomUUID())).rejects.toThrow(/workforce_membership_refused/);
    await db.query("update clinical_core.organization_memberships set status='suspended' where organization_id=$1 and person_id=$2", [clinic, person]);
    try { await expect(call()).rejects.toThrow(/workforce_membership_refused/); }
    finally { await db.query("update clinical_core.organization_memberships set status='active' where organization_id=$1 and person_id=$2", [clinic, person]); }
    expect((await call()).rows[0]?.binding.role).toBe('practitioner');
  });

  it('rolls back only the new proxy, leaving the parent proxies and private setter unchanged', async () => {
    const databaseName = (await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name;
    await db.exec(`alter function ${signature} set search_path=public`);
    try {
      await refusedCandidate(lf(rollback).replace("current_database() <> 'clinical_core_qualification'",
        `current_database() <> '${databaseName}'`), /qualification_proxy_changed/);
    } finally {
      await db.exec(`alter function ${signature} set search_path=''`);
    }
    expect((await call()).rows[0]?.binding.role).toBe('practitioner');
    await db.exec(lf(rollback).replace("current_database() <> 'clinical_core_qualification'", `current_database() <> '${databaseName}'`));
    expect((await db.query<{ oid: string | null }>(`select to_regprocedure('${signature}')::text as oid`)).rows[0]?.oid).toBeNull();
    for (const parent of ['clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)',
      'clinical_program_qualification.bounded_request(jsonb)', 'clinical_private.set_current_workforce_context(text,uuid,text)']) {
      expect((await db.query<{ oid: string | null }>('select to_regprocedure($1)::text as oid', [parent])).rows[0]?.oid).not.toBeNull();
    }
    await expect(baseRouteBinding()).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
