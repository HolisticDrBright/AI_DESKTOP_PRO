import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { assessAclRows, databaseAclSql, runConnectIsolationOperator }
  from './qualification-connect-isolation-operator.mjs';
import { databaseSql, loginSql, sessionSql }
  from './qualification-connect-isolation-preflight.mjs';
import { snapshotSql, privilegeSql } from './qualification-program-credential-operator.mjs';

const SQL_SHA256 = '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8';
const sql = readFileSync('infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation.sql', 'utf8');
const databases = ['alp_chat_rls_synthetic_v1', 'clinical_core',
  'clinical_core_qualification', 'postgres'];
const cluster = 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-cluster';
const secret = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional';
let split;
async function splitter() {
  if (split) return split;
  mkdirSync('dist/qualification-connect-isolation-operator-test', { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'],
    outfile: 'dist/qualification-connect-isolation-operator-test/migrations.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'silent' });
  split = createRequire(import.meta.url)('../dist/qualification-connect-isolation-operator-test/migrations.cjs')
    .splitPostgresStatements;
  return split;
}

function aclRows(state) {
  return databases.map(database => ({ database, owner: 'clinical_admin',
    acl: state === 'default' ? null : '{clinical_admin=C/clinical_admin}',
    default_acl: state === 'default', public_connect: state === 'default',
    program_login_connect: state === 'default' || database === 'clinical_core_qualification',
    program_api_connect: state === 'default', admin_connect: true, forward_connect: true }));
}

function fixture({ wrongAccount = false, siblingSession = false,
  rollbackLost = false, rollbackDrift = false } = {}) {
  let state = 'default';
  let statements = 0;
  const log = [];
  const caller = { Account: wrongAccount ? '173535830222' : '588966314750',
    Arn: `arn:aws:sts::${wrongAccount ? '173535830222' : '588966314750'}:assumed-role/fictional/test` };
  const foundation = { StackStatus: 'UPDATE_COMPLETE', Outputs: [
    ['DatabaseName', 'clinical_core_qualification'], ['PhiAllowed', 'false'],
    ['Activation', 'blocked'], ['DataClassification', 'synthetic_only'],
    ['DatabaseClusterArn', cluster], ['DatabaseSecretArn', secret],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) };
  const functionState = { FunctionName: '6zt8e9qz04-qualification-bound-programs',
    State: 'Active', LastUpdateStatus: 'Successful', Environment: { Variables: {
      PHI_ALLOWED: 'false', PROGRAM_ACTIVATION: 'blocked',
      CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
      MIGRATION_RELEASE_SHA256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
      CLINICAL_DATABASE_CLUSTER_ARN: cluster, CLINICAL_DATABASE_SECRET_ARN: secret,
    } } };
  const snapshot = { database: 'clinical_core_qualification', migration_count: 112,
    release_sha256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
    role_count: 2, schema_count: 1, program_count: 1, version_count: 1,
    published_count: 1, assignment_count: 1, fixture_count: 1,
    custody_sha256: 'c'.repeat(64), designated_count: 3,
    qualification_enabled: true, production_enabled: false, consumer_enabled: false };
  const privilege = { proxy_count: 2, safe_role_count: 2, membership_count: 1,
    total_memberships: 1, intact_proxy_count: 2, public_proxy_execute_count: 0,
    core_usage: false, private_usage: false, proxy_usage: true,
    bounded_execute: true, context_execute: true };
  return { caller, foundation, functionState, sql, log,
    query: async (statement, transactionId) => {
      log.push(['query', statement, transactionId]);
      if (statement === databaseSql) return aclRows('default').map(({ acl, admin_connect, forward_connect, ...row }) => row);
      if (statement === loginSql) return ['clinical_admin', 'rdsadmin', 'rdswriteforwarduser']
        .map(role => ({ role, can_login: true, superuser: role === 'rdsadmin' }));
      if (statement === sessionSql) return [{ database: siblingSession ? 'clinical_core' : 'clinical_core_qualification',
        role: 'clinical_admin', application: 'fictional', sessions: 1 }];
      if (statement === snapshotSql) return [snapshot];
      if (statement === privilegeSql) return [privilege];
      if (statement === databaseAclSql) return aclRows(rollbackDrift && state === 'rolled-back'
        ? 'isolated' : state === 'isolated' ? 'isolated' : 'default');
      throw new Error('unexpected query');
    },
    begin: async () => { log.push(['begin']); return 'fictional-transaction'; },
    execute: async (statement, transactionId) => {
      assert.equal(transactionId, 'fictional-transaction');
      log.push(['execute', statement]);
      if (statement.startsWith('set local')) return;
      if (++statements === 5) state = 'isolated';
    },
    rollback: async transactionId => {
      assert.equal(transactionId, 'fictional-transaction');
      log.push(['rollback']);
      if (rollbackLost) throw new Error('fictional_response_lost');
      state = rollbackDrift ? 'rolled-back' : 'default';
    },
  };
}

test('ACL inventory distinguishes exact default and isolated states, refusing a partial grant', () => {
  assert.equal(assessAclRows(aclRows('default')).grantState, 'default');
  assert.equal(assessAclRows(aclRows('isolated')).grantState, 'isolated');
  assert.notEqual(assessAclRows(aclRows('default')).aclSha256,
    assessAclRows(aclRows('isolated')).aclSha256);
  const partial = aclRows('default');
  partial[0].public_connect = false;
  assert.throws(() => assessAclRows(partial), /acl_drift/);
  assert.throws(() => assessAclRows(aclRows('default').slice(1)), /acl_inventory/);
});

test('inspect is read-only and refuses a rehearsal approval argument', async () => {
  const current = fixture();
  const result = await runConnectIsolationOperator({ ...current,
    mode: 'inspect', splitPostgresStatements: await splitter() });
  assert.equal(result.committed, false);
  assert.equal(result.contract, 'qualification-connect-isolation-operator/1');
  assert.equal(result.beforeGrantState, 'default');
  assert.equal(result.custodySha256, 'c'.repeat(64));
  assert.equal(result.clientInventoryComplete, false);
  assert.equal(current.log.some(([kind]) => kind === 'begin'), false);
  await assert.rejects(runConnectIsolationOperator({ ...fixture(), mode: 'inspect',
    approvalDigest: SQL_SHA256, splitPostgresStatements: await splitter() }),
  /approval_argument/);
});

test('approved rehearsal checks custody inside the transaction and proves exact rollback', async () => {
  const current = fixture();
  const result = await runConnectIsolationOperator({ ...current,
    mode: 'rehearse', approvalDigest: SQL_SHA256,
    splitPostgresStatements: await splitter() });
  assert.equal(result.rehearsalRolledBack, true);
  assert.equal(result.committed, false);
  assert.equal(result.afterAclSha256, result.beforeAclSha256);
  assert.equal(result.beforeGrantState, 'default');
  assert.equal(result.insideGrantState, 'isolated');
  assert.notEqual(result.insideAclSha256, result.beforeAclSha256);
  assert.equal(result.afterGrantState, 'default');
  assert.equal(current.log.filter(([kind]) => kind === 'begin').length, 1);
  assert.equal(current.log.filter(([kind]) => kind === 'rollback').length, 1);
});

test('wrong account, changed source, missing approval and a sibling session refuse before BEGIN', async () => {
  const cases = [
    { current: fixture({ wrongAccount: true }), change: {}, reason: /identity/ },
    { current: fixture({ siblingSession: true }), change: {}, reason: /sibling_session/ },
    { current: fixture(), change: { approvalDigest: undefined }, reason: /approval_argument/ },
    { current: fixture(), change: { sql: `${sql}\n-- changed` }, reason: /sql_hash/ },
  ];
  for (const { current, change, reason } of cases) {
    await assert.rejects(runConnectIsolationOperator({ ...current,
      mode: 'rehearse', approvalDigest: SQL_SHA256,
      splitPostgresStatements: await splitter(), ...change }), reason);
    assert.equal(current.log.some(([kind]) => kind === 'begin'), false);
  }
});

test('lost rollback response and changed ACL after rollback cannot produce a pass', async () => {
  for (const input of [fixture({ rollbackLost: true }), fixture({ rollbackDrift: true })]) {
    await assert.rejects(runConnectIsolationOperator({ ...input, mode: 'rehearse',
      approvalDigest: SQL_SHA256, splitPostgresStatements: await splitter() }),
    /rollback_outcome_uncertain_manual_inspection_required|rollback_acl_mismatch|acl_drift|snapshot_drift/);
  }
});
