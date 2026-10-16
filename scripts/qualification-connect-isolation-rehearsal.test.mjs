import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { connectIsolationStatements, rehearseConnectIsolation } from './qualification-connect-isolation-rehearsal.mjs';

const sql = readFileSync('infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation.sql', 'utf8');
async function splitter() {
  mkdirSync('dist/qualification-connect-isolation', { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'],
    outfile: 'dist/qualification-connect-isolation/migrations.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'silent' });
  return createRequire(import.meta.url)('../dist/qualification-connect-isolation/migrations.cjs')
    .splitPostgresStatements;
}

const digest = letter => letter.repeat(64);
function fakeTransport({ failExecute = false, failRollback = false, driftAfter = false } = {}) {
  let state = 'default';
  let rolled = false;
  let executes = 0;
  const log = [];
  return {
    log,
    begin: async () => { log.push('begin'); return 'fictional-transaction'; },
    execute: async (statement, transactionId) => {
      assert.equal(transactionId, 'fictional-transaction');
      log.push(statement.startsWith('set local') ? 'timeout' : 'statement');
      if (statement.startsWith('set local')) return;
      executes += 1;
      if (failExecute && executes === 5) throw new Error('fictional_late_failure');
      if (executes === 5) state = 'isolated';
    },
    inspect: async transactionId => {
      log.push(transactionId ? 'inspect-in-transaction' : 'inspect-outside');
      return { grantState: state, phiAllowed: false, productionActivation: 'blocked',
        programLoginActive: false,
        databases: ['alp_chat_rls_synthetic_v1', 'clinical_core',
          'clinical_core_qualification', 'postgres'],
        custodySha256: digest('c'), aclSha256: state === 'isolated' ? digest('b')
          : rolled && driftAfter ? digest('d') : digest('a') };
    },
    rollback: async transactionId => {
      assert.equal(transactionId, 'fictional-transaction');
      log.push('rollback');
      if (failRollback) throw new Error('fictional_rollback_failure');
      state = 'default'; rolled = true;
    },
  };
}

test('canonical splitter yields only the five exact interior statements', async () => {
  const split = await splitter();
  const statements = connectIsolationStatements(sql, split);
  assert.equal(statements.length, 5);
  assert.ok(statements.every(statement => !/^\s*(?:begin|commit|rollback)\s*$/i.test(statement)));
  assert.throws(() => connectIsolationStatements(sql.replace('REVOKE CONNECT', 'GRANT CONNECT'), split),
    /sql_hash/);
});

test('a successful rehearsal checks in-transaction state then rolls back exact ACLs', async () => {
  const transport = fakeTransport();
  const result = await rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(), ...transport });
  assert.equal(result.rehearsalRolledBack, true);
  assert.equal(result.committed, false);
  assert.equal(result.beforeAclSha256, digest('a'));
  assert.deepEqual(transport.log.slice(-3), ['inspect-in-transaction', 'rollback', 'inspect-outside']);
  assert.equal(transport.log[2], 'timeout');
});

test('late execution error rolls back; uncertain rollback never becomes a pass', async () => {
  const transport = fakeTransport({ failExecute: true });
  await assert.rejects(rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(),
    ...transport }), /fictional_late_failure/);
  assert.ok(transport.log.includes('rollback'));
  const uncertain = fakeTransport({ failExecute: true, failRollback: true });
  await assert.rejects(rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(),
    ...uncertain }), /rollback_outcome_uncertain_manual_inspection_required/);
});

test('a changed ACL after rollback is refused', async () => {
  const transport = fakeTransport({ driftAfter: true });
  await assert.rejects(rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(),
    ...transport }), /rollback_acl_mismatch/);
});

test('altered source is refused before a transaction begins', async () => {
  const transport = fakeTransport();
  await assert.rejects(rehearseConnectIsolation({ sql: `${sql}\n-- altered`,
    splitPostgresStatements: await splitter(), ...transport }), /sql_hash/);
  assert.deepEqual(transport.log, []);
});

test('activated login or changed database inventory refuses before a transaction', async () => {
  const active = fakeTransport();
  const activeInspect = active.inspect;
  active.inspect = async transactionId => ({ ...await activeInspect(transactionId),
    programLoginActive: true });
  await assert.rejects(rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(),
    ...active }), /snapshot_drift/);
  assert.equal(active.log.includes('begin'), false);
  const drift = fakeTransport();
  const driftInspect = drift.inspect;
  drift.inspect = async transactionId => ({ ...await driftInspect(transactionId),
    databases: ['changed'] });
  await assert.rejects(rehearseConnectIsolation({ sql, splitPostgresStatements: await splitter(),
    ...drift }), /snapshot_drift/);
  assert.equal(drift.log.includes('begin'), false);
});
