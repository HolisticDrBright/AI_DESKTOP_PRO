/** Exact-target, rollback-only operator for the BLOCKED fictional CONNECT candidate.
 * `inspect` is read-only. `rehearse` issues temporary DDL in one RDS Data API
 * transaction and always rolls it back; it requires separate owner approval.
 * There is deliberately no apply/commit mode. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { BeginTransactionCommand, ExecuteStatementCommand, RDSDataClient,
  RollbackTransactionCommand } from '@aws-sdk/client-rds-data';
import { assertPrivileges, assertSnapshot, privilegeSql, snapshotSql }
  from './qualification-program-credential-operator.mjs';
import { ACCOUNT, REGION, PROFILE, DATABASE, DATABASES, FOUNDATION, FUNCTION,
  assertCandidateDigests, assertTargetPosture, assessConnectPreflight,
  databaseSql, loginSql, sessionSql } from './qualification-connect-isolation-preflight.mjs';
import { connectIsolationStatements, rehearseConnectIsolation }
  from './qualification-connect-isolation-rehearsal.mjs';

const SQL_PATH = 'infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation.sql';
const SQL_SHA256 = '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8';
const refuse = reason => { throw new Error(`qualification_connect_operator_refused:${reason}`); };
const check = (condition, reason) => { if (!condition) refuse(reason); };
const sha = value => createHash('sha256').update(value).digest('hex');

// pg_database is cluster-global, so the same transaction can observe all four
// ACLs without connecting to a sibling database. Keep the raw ACL text in the
// digest: a logically equivalent but different rollback representation is not
// an exact return to the reviewed starting state.
export const databaseAclSql = `select datname as database, pg_get_userbyid(datdba) as owner,
 datacl::text as acl, datacl is null as default_acl,
 exists(select 1 from aclexplode(coalesce(datacl,acldefault('d',datdba))) a
   where a.grantee=0 and a.privilege_type='CONNECT') as public_connect,
 has_database_privilege('clinical_program_qualification_login',datname,'CONNECT') as program_login_connect,
 has_database_privilege('clinical_program_qualification_api',datname,'CONNECT') as program_api_connect,
 has_database_privilege('clinical_admin',datname,'CONNECT') as admin_connect,
 has_database_privilege('rdswriteforwarduser',datname,'CONNECT') as forward_connect
 from pg_database where datallowconn and not datistemplate and datname <> 'rdsadmin' order by datname`;

export function assessAclRows(rows) {
  check(Array.isArray(rows) && rows.length === DATABASES.length
    && rows.every((row, index) => row?.database === DATABASES[index]
      && row.owner === 'clinical_admin' && (row.acl === null || typeof row.acl === 'string')
      && ['default_acl', 'public_connect', 'program_login_connect',
        'program_api_connect', 'admin_connect', 'forward_connect']
        .every(key => typeof row[key] === 'boolean')), 'acl_inventory');
  const defaultState = rows.every(row => row.acl === null && row.default_acl
    && row.public_connect && row.program_login_connect && row.program_api_connect
    && row.admin_connect && row.forward_connect);
  const isolatedState = rows.every(row => row.acl !== null && !row.default_acl
    && !row.public_connect && row.program_login_connect === (row.database === DATABASE)
    && !row.program_api_connect && row.admin_connect && row.forward_connect);
  check(defaultState || isolatedState, 'acl_drift');
  return { grantState: defaultState ? 'default' : 'isolated',
    aclSha256: sha(JSON.stringify(rows)) };
}

export async function runConnectIsolationOperator({ mode, approvalDigest, caller,
  foundation, functionState, sql, splitPostgresStatements, query, begin,
  execute, rollback }) {
  check(mode === 'inspect' || mode === 'rehearse', 'mode');
  check(mode === 'rehearse' ? approvalDigest === SQL_SHA256 : approvalDigest === undefined,
    'approval_argument');
  check([query, begin, execute, rollback, splitPostgresStatements]
    .every(value => typeof value === 'function'), 'interface');
  const outputs = assertTargetPosture({ caller, foundation, functionState });
  // Refuse an altered candidate before even the first read, much less BEGIN.
  connectIsolationStatements(sql, splitPostgresStatements);
  const databaseRows = await query(databaseSql);
  const loginRows = await query(loginSql);
  const sessionRows = await query(sessionSql);
  const preflight = assessConnectPreflight({ caller, foundation, functionState,
    databaseRows, loginRows, sessionRows });
  const inspect = async transactionId => {
    // RDS Data API permits one statement at a time on a transaction id.
    const snapshotRows = await query(snapshotSql, transactionId);
    const privilegeRows = await query(privilegeSql, transactionId);
    const aclRows = await query(databaseAclSql, transactionId);
    check(snapshotRows.length === 1 && privilegeRows.length === 1, 'snapshot_count');
    assertSnapshot(snapshotRows[0], true);
    assertPrivileges(privilegeRows[0]);
    const acl = assessAclRows(aclRows);
    return { ...acl, phiAllowed: false, productionActivation: 'blocked',
      programLoginActive: false, databases: DATABASES,
      custodySha256: snapshotRows[0].custody_sha256 };
  };
  const before = await inspect();
  check(before.grantState === 'default', 'starting_acl');
  const report = { contract: 'qualification-connect-isolation-operator/1',
    accountId: ACCOUNT, region: REGION, database: DATABASE, clusterArn: outputs.DatabaseClusterArn,
    mode, sqlSha256: SQL_SHA256, ...preflight, beforeAclSha256: before.aclSha256,
    committed: false };
  if (mode === 'inspect') return report;
  // A current sibling session is an immediate refusal. Its absence is still
  // only a snapshot; separate reviewed client inventory and owner approval
  // are required before anyone invokes this rehearsal mode.
  check(preflight.observedSiblingSessions.length === 0, 'sibling_session');
  const result = await rehearseConnectIsolation({ sql, splitPostgresStatements,
    begin, execute, inspect, rollback });
  return { ...report, rehearsalRolledBack: result.rehearsalRolledBack,
    afterAclSha256: result.beforeAclSha256 };
}

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

async function canonicalSplitter() {
  mkdirSync('dist/qualification-connect-isolation', { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'],
    outfile: 'dist/qualification-connect-isolation/migrations.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'silent' });
  return createRequire(import.meta.url)('../dist/qualification-connect-isolation/migrations.cjs')
    .splitPostgresStatements;
}

async function main() {
  const [mode, approvalDigest] = process.argv.slice(2);
  check(mode === 'inspect' || mode === 'rehearse', 'command');
  check(mode === 'rehearse' ? approvalDigest === SQL_SHA256 : approvalDigest === undefined,
    'approval_argument');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'],
    { encoding: 'utf8', windowsHide: true }).trim();
  check(/^[a-f0-9]{40}$/.test(sourceCommit)
    && !execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', windowsHide: true }).trim(), 'dirty_source');
  assertCandidateDigests();
  const sql = readFileSync(SQL_PATH, 'utf8');
  const splitPostgresStatements = await canonicalSplitter();
  const caller = aws('sts', 'get-caller-identity');
  const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', FOUNDATION).Stacks?.[0];
  const functionState = aws('lambda', 'get-function-configuration', '--function-name', FUNCTION);
  const outputs = assertTargetPosture({ caller, foundation, functionState });
  const common = { resourceArn: outputs.DatabaseClusterArn, secretArn: outputs.DatabaseSecretArn,
    database: DATABASE };
  const client = new RDSDataClient({ region: REGION,
    credentials: fromIni({ profile: PROFILE }), maxAttempts: 1 });
  const query = async (statement, transactionId) => {
    const response = await client.send(new ExecuteStatementCommand({ ...common,
      transactionId, sql: statement, formatRecordsAs: 'JSON' }));
    return JSON.parse(response.formattedRecords ?? '[]');
  };
  const result = await runConnectIsolationOperator({ mode, approvalDigest,
    caller, foundation, functionState, sql, splitPostgresStatements, query,
    begin: async () => (await client.send(new BeginTransactionCommand(common))).transactionId,
    execute: async (statement, transactionId) => {
      await query(statement, transactionId);
    },
    rollback: async transactionId => {
      await client.send(new RollbackTransactionCommand({ ...common, transactionId }));
    },
  });
  console.log(JSON.stringify({ ...result, sourceCommit }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(String(error?.message ?? 'qualification_connect_operator_failed'));
    process.exitCode = 1;
  });
}
