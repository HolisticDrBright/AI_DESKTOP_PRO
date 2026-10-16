import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCandidateDigests, assessConnectPreflight } from './qualification-connect-isolation-preflight.mjs';

const cluster = 'arn:aws:rds:us-east-2:588966314750:cluster:fictional-cluster';
const secret = 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-fictional';
const databases = ['alp_chat_rls_synthetic_v1', 'clinical_core',
  'clinical_core_qualification', 'postgres'];
const fixture = () => ({
  caller: { Account: '588966314750',
    Arn: 'arn:aws:sts::588966314750:assumed-role/OrganizationAccountAccessRole/fictional' },
  foundation: { StackStatus: 'CREATE_COMPLETE', Outputs: [
    ['DatabaseName', 'clinical_core_qualification'], ['PhiAllowed', 'false'],
    ['Activation', 'blocked'], ['DataClassification', 'synthetic_only'],
    ['DatabaseClusterArn', cluster], ['DatabaseSecretArn', secret],
  ].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) },
  functionState: { FunctionName: '6zt8e9qz04-qualification-bound-programs',
    State: 'Active', LastUpdateStatus: 'Successful', Environment: { Variables: {
    PHI_ALLOWED: 'false', PROGRAM_ACTIVATION: 'blocked',
    CLINICAL_DATABASE_NAME: 'clinical_core_qualification',
    MIGRATION_RELEASE_SHA256: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
    CLINICAL_DATABASE_CLUSTER_ARN: cluster, CLINICAL_DATABASE_SECRET_ARN: secret,
  } } },
  databaseRows: databases.map(database => ({ database, owner: 'clinical_admin',
    default_acl: true, public_connect: true, program_login_connect: true,
    program_api_connect: true })),
  loginRows: ['clinical_admin', 'rdsadmin', 'rdswriteforwarduser'].map(role => ({
    role, can_login: true, superuser: role === 'rdsadmin',
  })),
  sessionRows: [{ database: 'clinical_core_qualification', role: 'clinical_admin',
    application: 'rds-data-api', sessions: 1 }],
});

test('candidate digests are pinned without exposing a secret', () => {
  assert.deepEqual(assertCandidateDigests(), [
    '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8',
    '7b055449b45e1cf29aa04831235ef284e2de30276a729722a7ffab2ff9cb2341',
  ]);
  assert.throws(() => assertCandidateDigests(() => 'changed'), /candidate_digest/);
});

test('valid read-only observations never become an approval to change grants', () => {
  const result = assessConnectPreflight(fixture());
  assert.equal(result.clientInventoryComplete, false);
  assert.equal(result.eligibleForAwsGrantChange, false);
  assert.equal(result.sessionSnapshotOnly, true);
  assert.deepEqual(result.observedSiblingSessions, []);
});

test('root identity, activated Lambda and changed foundation refuse', () => {
  const root = fixture();
  root.caller.Arn = 'arn:aws:iam::588966314750:root';
  assert.throws(() => assessConnectPreflight(root), /identity/);
  const activated = fixture();
  activated.functionState.Environment.Variables.PHI_ALLOWED = 'true';
  assert.throws(() => assessConnectPreflight(activated), /lambda_posture/);
  const production = fixture();
  production.foundation.Outputs.find(row => row.OutputKey === 'Activation').OutputValue = 'approved';
  assert.throws(() => assessConnectPreflight(production), /foundation/);
});

test('database and login drift refuse, including non-default grants', () => {
  const changedAcl = fixture();
  changedAcl.databaseRows[0].default_acl = false;
  assert.throws(() => assessConnectPreflight(changedAcl), /database_grant_drift/);
  const newDatabase = fixture();
  newDatabase.databaseRows.push({ ...newDatabase.databaseRows[0], database: 'another' });
  assert.throws(() => assessConnectPreflight(newDatabase), /database_grant_drift/);
  const newLogin = fixture();
  newLogin.loginRows.push({ role: 'unreviewed_client', can_login: true, superuser: false });
  assert.throws(() => assessConnectPreflight(newLogin), /login_role_drift/);
});

test('observed sibling sessions are reported, never treated as complete client inventory', () => {
  const current = fixture();
  current.sessionRows.push({ database: 'clinical_core', role: 'clinical_admin',
    application: 'unknown-client', sessions: 2 });
  const result = assessConnectPreflight(current);
  assert.equal(result.observedSiblingSessions.length, 1);
  assert.equal(result.observedSiblingSessions[0].sessions, 2);
  assert.equal(result.eligibleForAwsGrantChange, false);
  const malformed = fixture();
  malformed.sessionRows[0].sessions = -1;
  assert.throws(() => assessConnectPreflight(malformed), /session_inventory/);
});
