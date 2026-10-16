import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import {
  assertPrivileges, assertSnapshot, credentialStatements, privilegeSql,
} from './qualification-program-credential-operator.mjs';

const sql = readFileSync('infra/aws-clinical-core/source-candidates/qualification-program-api-login.sql', 'utf8');
async function splitter() {
  mkdirSync('dist/qualification-program-credential', { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'],
    outfile: 'dist/qualification-program-credential/migrations.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'silent' });
  return createRequire(import.meta.url)('../dist/qualification-program-credential/migrations.cjs')
    .splitPostgresStatements;
}

test('the exact reviewed file yields only interior single statements for an RDS transaction', async () => {
  const split = await splitter();
  const statements = credentialStatements(sql, split);
  assert.ok(statements.length >= 5);
  assert.match(statements[0], /qualification_database_refused/);
  assert.match(statements.at(-1), /grant clinical_program_qualification_api to clinical_program_qualification_login/);
  assert.ok(statements.every(statement => !/^\s*(?:begin|commit|rollback)\s*$/i.test(statement)));
  assert.throws(() => credentialStatements(sql.replace('nologin noinherit', 'login noinherit'), split),
    /qualification_credential_refused:sql_hash/);
});

test('an operator transaction rolls back a late failure after creating roles and proxies', async () => {
  const statements = credentialStatements(sql, await splitter());
  const db = new PGlite();
  try {
    await db.exec(`create role clinical_core_api nologin noinherit;
      create schema clinical_core; create schema clinical_private;
      create function clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)
        returns void language sql as $$ select null::void $$;
      create function clinical_core.production_program_bounded_request(jsonb)
        returns jsonb language sql as $$ select $1 $$;`);
    const database = (await db.query('select current_database() as name')).rows[0].name;
    await assert.rejects(db.transaction(async tx => {
      for (const statement of statements) {
        const scoped = statement.replace("current_database() <> 'clinical_core_qualification'",
          `current_database() <> '${database}'`);
        await tx.exec(scoped.replace('grant clinical_program_qualification_api to clinical_program_qualification_login',
          'grant nonexistent_qualification_role to clinical_program_qualification_login'));
      }
    }), /nonexistent_qualification_role/);
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname like 'clinical_program_qualification_%'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int as n from pg_namespace where nspname='clinical_program_qualification'")).rows[0].n, 0);
    await assert.rejects(db.transaction(async tx => {
      for (const statement of statements) await tx.exec(statement.replace(
        "current_database() <> 'clinical_core_qualification'", `current_database() <> '${database}'`));
      assertPrivileges((await tx.query(privilegeSql)).rows[0]);
      throw new Error('rollback_fixture');
    }), /rollback_fixture/);
    assert.equal((await db.query("select count(*)::int as n from pg_roles where rolname like 'clinical_program_qualification_%'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('qualification snapshot and privilege checks refuse drift rather than accepting a partial apply', () => {
  const before = { database: 'clinical_core_qualification', migration_count: 112,
    release_sha256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
    role_count: 0, schema_count: 0, program_count: 1, version_count: 1, published_count: 1,
    assignment_count: 1, fixture_count: 1, custody_sha256: 'a'.repeat(64), designated_count: 3,
    qualification_enabled: true, production_enabled: false, consumer_enabled: false };
  assert.doesNotThrow(() => assertSnapshot(before, false));
  assert.doesNotThrow(() => assertSnapshot(before, false, 'a'.repeat(64)));
  assert.throws(() => assertSnapshot({ ...before, role_count: 1 }, false), /candidate_state/);
  assert.throws(() => assertSnapshot({ ...before, production_enabled: true }, false), /fixture_or_activation/);
  assert.throws(() => assertSnapshot({ ...before, assignment_count: 2 }, false), /fixture_or_activation/);
  assert.throws(() => assertSnapshot({ ...before, fixture_count: 0 }, false), /fixture_or_activation/);
  assert.throws(() => assertSnapshot({ ...before, custody_sha256: 'b'.repeat(64) }, false, 'a'.repeat(64)),
    /fixture_or_activation/);
  const privileges = { proxy_count: 2, safe_role_count: 2, membership_count: 1,
    total_memberships: 1, intact_proxy_count: 2, public_proxy_execute_count: 0,
    core_usage: false, private_usage: false, proxy_usage: true,
    bounded_execute: true, context_execute: true };
  assert.doesNotThrow(() => assertPrivileges(privileges));
  assert.throws(() => assertPrivileges({ ...privileges, core_usage: true }), /privileges/);
  assert.throws(() => assertPrivileges({ ...privileges, proxy_count: 1 }), /privileges/);
});
