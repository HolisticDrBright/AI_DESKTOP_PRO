import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const parent = JSON.parse(read('infra/aws-clinical-core/qualification-program-api-successor.json'));
const candidate = JSON.parse(read('infra/aws-clinical-core/qualification-program-api-restricted-credential.json'));
const loginSql = read('infra/aws-clinical-core/source-candidates/qualification-program-api-login.sql');

test('the bundled Lambda binds both exact proxy bodies, with no callable clinical-schema grant', () => {
  const entry = read('src/server/clinical-core/aws-qualification-program-lambda.ts');
  const expected = ['set_request_context', 'bounded_request'].map(name => {
    const start = loginSql.indexOf(`create function clinical_program_qualification.${name}(`);
    assert.ok(start >= 0);
    const bodyStart = loginSql.indexOf('as $$', start) + 'as $$'.length;
    const bodyEnd = loginSql.indexOf('$$;', bodyStart);
    assert.ok(bodyEnd > bodyStart);
    return { name: `clinical_program_qualification.${name}`,
      bodySha256: createHash('sha256').update(loginSql.slice(bodyStart, bodyEnd)).digest('hex') };
  });
  for (const binding of expected) {
    assert.match(entry, new RegExp(`name: '${binding.name.replaceAll('.', '\\.')}[\\s\\S]*?bodySha256: '${binding.bodySha256}'`));
  }
  assert.doesNotMatch(loginSql, /grant usage on schema clinical_(?:core|private) to clinical_program_qualification_api/i);
  assert.match(loginSql, /revoke all on schema clinical_program_qualification from public/i);
});

test('restricted-credential successor is generated and changes only its pinned secret boundary', () => {
  execFileSync(process.execPath, ['scripts/build-qualification-program-api-restricted-credential.mjs', '--check']);
  const expected = structuredClone(parent);
  expected.Metadata.ClinicalCore.ContractVersion = 'qualification-program-api-candidate/3';
  expected.Metadata.ClinicalCore.SourceTemplate = 'infra/aws-clinical-core/qualification-program-api-successor.json';
  expected.Metadata.ClinicalCore.CredentialBoundary = candidate.Metadata.ClinicalCore.CredentialBoundary;
  expected.Metadata.ClinicalCore.DeploymentGate = candidate.Metadata.ClinicalCore.DeploymentGate;
  expected.Parameters.DatabaseSecretArn.AllowedPattern = candidate.Parameters.DatabaseSecretArn.AllowedPattern;
  expected.Description = candidate.Description;
  assert.deepEqual(candidate, expected);
  assert.match(candidate.Parameters.DatabaseSecretArn.AllowedPattern, /alp-qualification-program-api-db-/);
  assert.doesNotMatch('arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-example',
    new RegExp(candidate.Parameters.DatabaseSecretArn.AllowedPattern));
  assert.equal(candidate.Resources.IdentityApiFunction.Properties.Environment.Variables.PHI_ALLOWED, 'false');
  assert.equal(candidate.Resources.IdentityApiFunction.Properties.Environment.Variables.PROGRAM_ACTIVATION, 'blocked');
});

test('candidate login starts disabled, can assume only the proxy role, and refuses replay', async () => {
  assert.match(loginSql, /current_database\(\) <> 'clinical_core_qualification'/);
  assert.match(loginSql, /create role clinical_program_qualification_api/);
  assert.doesNotMatch(loginSql, /grant clinical_core_api to clinical_program_qualification_login/i);
  assert.doesNotMatch(loginSql, /\bpassword\b\s*'/i);
  const db = new PGlite();
  try {
    await db.exec(`create role clinical_core_api nologin noinherit;
      create role clinical_core_migrator nologin noinherit;
      create schema clinical_core; create schema clinical_private;
      create function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)
        returns void language sql as $$ select null::void $$;
      create function clinical_core.production_program_bounded_request(jsonb)
        returns jsonb language sql as $$ select $1 $$;
      revoke all on function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text) from public;
      revoke all on function clinical_core.production_program_bounded_request(jsonb) from public;
      create table clinical_core.private_data(id integer);`);
    const database = (await db.query('select current_database() as name')).rows[0].name;
    await db.exec(loginSql.replace("current_database() <> 'clinical_core_qualification'",
      `current_database() <> '${database}'`));
    const result = await db.query(`select rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      from pg_roles where rolname = 'clinical_program_qualification_login'`);
    assert.deepEqual(result.rows, [{ rolcanlogin: false, rolinherit: false, rolsuper: false,
      rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    const membership = await db.query(`select parent.rolname as parent, m.admin_option, m.inherit_option, m.set_option
      from pg_auth_members m join pg_roles parent on parent.oid = m.roleid
      join pg_roles member on member.oid = m.member where member.rolname = 'clinical_program_qualification_login'`);
    assert.deepEqual(membership.rows, [{ parent: 'clinical_program_qualification_api', admin_option: false,
      inherit_option: false, set_option: true }]);
    await db.exec('set session authorization clinical_program_qualification_login');
    await assert.rejects(db.exec('set role clinical_core_migrator'), /permission denied/);
    await assert.rejects(db.exec('set role clinical_core_api'), /permission denied/);
    await db.exec('set role clinical_program_qualification_api');
    assert.equal((await db.query('select current_user as name')).rows[0].name, 'clinical_program_qualification_api');
    assert.equal((await db.query(`select has_schema_privilege(current_user,'clinical_core','USAGE') as allowed`)).rows[0].allowed, false);
    assert.equal((await db.query(`select has_schema_privilege(current_user,'clinical_private','USAGE') as allowed`)).rows[0].allowed, false);
    assert.equal((await db.query(`select has_function_privilege(current_user,
      'clinical_program_qualification.bounded_request(jsonb)', 'EXECUTE') as allowed`)).rows[0].allowed, true);
    assert.deepEqual((await db.query(`select clinical_program_qualification.bounded_request('{"fictional":true}'::jsonb) as data`)).rows[0].data,
      { fictional: true });
    await assert.rejects(db.query(`select clinical_core.production_program_bounded_request('{}'::jsonb)`), /permission denied/);
    await assert.rejects(db.query('select * from clinical_core.private_data'), /permission denied/);
    await db.exec('reset session authorization');
    await assert.rejects(db.exec(loginSql.replace("current_database() <> 'clinical_core_qualification'",
      `current_database() <> '${database}'`)), /qualification_roles_already_exist/);
  } finally { await db.close(); }
});

test('exact candidate refuses a non-qualification database without creating the role', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role clinical_core_api nologin noinherit');
    await assert.rejects(db.exec(loginSql), /qualification_database_refused/);
    const result = await db.query("select count(*)::integer as n from pg_roles where rolname = 'clinical_program_qualification_login'");
    assert.equal(result.rows[0].n, 0);
  } finally { await db.close(); }
});

test('candidate refuses a missing API role before creating the login', async () => {
  const db = new PGlite();
  try {
    const database = (await db.query('select current_database() as name')).rows[0].name;
    await assert.rejects(db.exec(loginSql.replace("current_database() <> 'clinical_core_qualification'",
      `current_database() <> '${database}'`)), /clinical_api_role_refused/);
    const result = await db.query("select count(*)::integer as n from pg_roles where rolname = 'clinical_program_qualification_login'");
    assert.equal(result.rows[0].n, 0);
  } finally { await db.close(); }
});
