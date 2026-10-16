import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const applySql = readFileSync('infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation.sql', 'utf8');
const rollbackSql = readFileSync('infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation-rollback.sql', 'utf8');
const digest = sql => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
const forEmbeddedDatabase = sql => sql.replace(
  "current_database() <> 'clinical_core_qualification'", "current_database() <> 'postgres'");

async function fixture() {
  const db = new PGlite();
  await db.exec(`create role clinical_admin login;
    create role rdswriteforwarduser login;
    create role clinical_program_qualification_api nologin;
    create role clinical_program_qualification_login nologin;`);
  for (const name of ['alp_chat_rls_synthetic_v1', 'clinical_core', 'clinical_core_qualification']) {
    await db.query(`create database ${name}`);
  }
  return db;
}

async function canConnect(db, role, database) {
  const result = await db.query('select has_database_privilege($1,$2,\'CONNECT\') as allowed', [role, database]);
  return result.rows[0].allowed;
}

test('both blocked candidates retain their reviewed LF digests', () => {
  assert.equal(digest(applySql), '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8');
  assert.equal(digest(rollbackSql), '7b055449b45e1cf29aa04831235ef284e2de30276a729722a7ffab2ff9cb2341');
});

test('blocked candidate removes sibling CONNECT while preserving known callers, and rollback restores effective grants', async () => {
  const db = await fixture();
  try {
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core'), true);
    await db.exec(forEmbeddedDatabase(applySql));
    for (const sibling of ['alp_chat_rls_synthetic_v1', 'clinical_core', 'postgres']) {
      assert.equal(await canConnect(db, 'clinical_program_qualification_login', sibling), false);
      assert.equal(await canConnect(db, 'clinical_program_qualification_api', sibling), false);
      assert.equal(await canConnect(db, 'clinical_admin', sibling), true);
      assert.equal(await canConnect(db, 'rdswriteforwarduser', sibling), true);
    }
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core_qualification'), true);
    await db.exec(forEmbeddedDatabase(rollbackSql));
    for (const database of ['alp_chat_rls_synthetic_v1', 'clinical_core', 'clinical_core_qualification', 'postgres']) {
      assert.equal(await canConnect(db, 'clinical_program_qualification_login', database), true);
      assert.equal(await canConnect(db, 'clinical_program_qualification_api', database), true);
    }
  } finally { await db.close(); }
});

test('candidate refuses a wrong database or changed grant inventory before mutation', async () => {
  const db = await fixture();
  try {
    await assert.rejects(db.exec(applySql), /qualification_connect_wrong_database/);
    await db.query('rollback');
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core'), true);
    await db.exec('create role extra_login login; grant connect on database clinical_core to extra_login');
    await assert.rejects(db.exec(forEmbeddedDatabase(applySql)), /qualification_connect_acl_changed/);
    await db.query('rollback');
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core'), true);
  } finally { await db.close(); }
});

test('late apply failure rolls back grants; rollback refuses after login activation', async () => {
  const db = await fixture();
  try {
    const broken = forEmbeddedDatabase(applySql).replace(
      'TO clinical_program_qualification_login;', 'TO missing_qualification_role;');
    await assert.rejects(db.exec(broken), /missing_qualification_role/);
    await db.query('rollback');
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core'), true);
    await db.exec(forEmbeddedDatabase(applySql));
    await db.exec('alter role clinical_program_qualification_login login');
    await assert.rejects(db.exec(forEmbeddedDatabase(rollbackSql)), /qualification_connect_rollback_role_activated/);
    await db.query('rollback');
    assert.equal(await canConnect(db, 'clinical_program_qualification_login', 'clinical_core'), false);
  } finally { await db.close(); }
});
