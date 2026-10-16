/** Read-only inventory for a BLOCKED synthetic database CONNECT candidate. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { assertPrivileges, assertSnapshot, privilegeSql, snapshotSql } from './qualification-program-credential-operator.mjs';

export const ACCOUNT = '588966314750';
export const REGION = 'us-east-2';
export const PROFILE = 'ai-synthetic-member';
export const DATABASE = 'clinical_core_qualification';
export const FOUNDATION = 'ai-clinical-core-qualification-foundation';
export const FUNCTION = '6zt8e9qz04-qualification-bound-programs';
export const RELEASE = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
export const DATABASES = Object.freeze([
  'alp_chat_rls_synthetic_v1', 'clinical_core', DATABASE, 'postgres',
]);
const LOGINS = Object.freeze(['clinical_admin', 'rdsadmin', 'rdswriteforwarduser']);
const CANDIDATES = Object.freeze([
  ['infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation.sql',
    '28e0d4bd1dc30f0abb6732ec44250f480844662a440e8461091735c8d53621f8'],
  ['infra/aws-clinical-core/source-candidates/qualification-database-connect-isolation-rollback.sql',
    '7b055449b45e1cf29aa04831235ef284e2de30276a729722a7ffab2ff9cb2341'],
]);

const refuse = reason => { throw new Error(`qualification_connect_preflight_refused:${reason}`); };
const check = (condition, reason) => { if (!condition) refuse(reason); };

export function assertCandidateDigests(read = path => readFileSync(path, 'utf8')) {
  for (const [path, expected] of CANDIDATES) {
    const bytes = read(path).replace(/\r\n/g, '\n');
    check(createHash('sha256').update(bytes).digest('hex') === expected, 'candidate_digest');
  }
  return CANDIDATES.map(([, digest]) => digest);
}

export function assertTargetPosture({ caller, foundation, functionState }) {
  check(caller?.Account === ACCOUNT
    && String(caller.Arn ?? '').startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/`), 'identity');
  const outputs = Object.fromEntries((foundation?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
  check(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(foundation?.StackStatus)
    && outputs.DatabaseName === DATABASE && outputs.PhiAllowed === 'false'
    && outputs.Activation === 'blocked' && outputs.DataClassification === 'synthetic_only'
    && outputs.DatabaseClusterArn?.startsWith(`arn:aws:rds:${REGION}:${ACCOUNT}:cluster:`)
    && outputs.DatabaseSecretArn?.startsWith(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!cluster-`),
  'foundation');
  const variables = functionState?.Environment?.Variables ?? {};
  check(functionState?.FunctionName === FUNCTION && functionState.State === 'Active'
    && functionState.LastUpdateStatus === 'Successful'
    && variables.PHI_ALLOWED === 'false' && variables.PROGRAM_ACTIVATION === 'blocked'
    && variables.CLINICAL_DATABASE_NAME === DATABASE
    && variables.MIGRATION_RELEASE_SHA256 === RELEASE
    && variables.CLINICAL_DATABASE_CLUSTER_ARN === outputs.DatabaseClusterArn
    && variables.CLINICAL_DATABASE_SECRET_ARN === outputs.DatabaseSecretArn,
  'lambda_posture');
  return outputs;
}

export function assessConnectPreflight({ caller, foundation, functionState,
  databaseRows, loginRows, sessionRows }) {
  assertTargetPosture({ caller, foundation, functionState });
  check(Array.isArray(databaseRows) && databaseRows.length === DATABASES.length
    && databaseRows.every((row, index) => row.database === DATABASES[index]
      && row.owner === 'clinical_admin' && row.default_acl === true
      && row.public_connect === true && row.program_login_connect === true
      && row.program_api_connect === true), 'database_grant_drift');
  check(Array.isArray(loginRows) && loginRows.length === LOGINS.length
    && loginRows.every((row, index) => row.role === LOGINS[index] && row.can_login === true
      && (row.role !== 'rdsadmin' || row.superuser === true)), 'login_role_drift');
  check(Array.isArray(sessionRows) && sessionRows.every(row =>
    typeof row.database === 'string' && typeof row.role === 'string'
      && typeof row.application === 'string' && Number.isInteger(row.sessions)
      && row.sessions > 0), 'session_inventory');
  const siblingSessions = sessionRows.filter(row => row.database !== DATABASE
    && row.database !== 'rdsadmin');
  return {
    contract: 'qualification-connect-isolation-preflight/1',
    accountId: ACCOUNT, region: REGION, database: DATABASE,
    observedDatabases: DATABASES, observedLoginRoles: LOGINS,
    observedSiblingSessions: siblingSessions,
    sessionSnapshotOnly: true, clientInventoryComplete: false,
    eligibleForAwsGrantChange: false,
    reason: 'separate_client_review_rollback_rehearsal_and_owner_approval_required',
  };
}

export const databaseSql = `select datname as database, pg_get_userbyid(datdba) as owner,
 datacl is null as default_acl,
 exists(select 1 from aclexplode(coalesce(datacl,acldefault('d',datdba))) acl
   where acl.grantee=0 and acl.privilege_type='CONNECT') as public_connect,
 has_database_privilege('clinical_program_qualification_login',datname,'CONNECT') as program_login_connect,
 has_database_privilege('clinical_program_qualification_api',datname,'CONNECT') as program_api_connect
 from pg_database where datallowconn and not datistemplate and datname <> 'rdsadmin' order by datname`;
export const loginSql = `select rolname as role, rolcanlogin as can_login, rolsuper as superuser
 from pg_roles where rolcanlogin order by rolname`;
export const sessionSql = `select datname as database, usename as role,
 coalesce(nullif(application_name,''),'<none>') as application, count(*)::int as sessions
 from pg_stat_activity where datname is not null
 group by datname,usename,application_name order by datname,usename,application_name`;

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

async function main() {
  check(process.argv.length === 2, 'command');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'],
    { encoding: 'utf8', windowsHide: true }).trim();
  check(/^[a-f0-9]{40}$/.test(sourceCommit)
    && !execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', windowsHide: true }).trim(), 'dirty_source');
  const sqlSha256 = assertCandidateDigests();
  const caller = aws('sts', 'get-caller-identity');
  const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', FOUNDATION).Stacks?.[0];
  const functionState = aws('lambda', 'get-function-configuration', '--function-name', FUNCTION);
  const outputs = assertTargetPosture({ caller, foundation, functionState });
  const client = new RDSDataClient({ region: REGION, credentials: fromIni({ profile: PROFILE }), maxAttempts: 1 });
  const query = async sql => {
    const response = await client.send(new ExecuteStatementCommand({
      resourceArn: outputs.DatabaseClusterArn, secretArn: outputs.DatabaseSecretArn,
      database: DATABASE, sql, formatRecordsAs: 'JSON',
    }));
    return JSON.parse(response.formattedRecords ?? '[]');
  };
  assertSnapshot((await query(snapshotSql))[0], true);
  assertPrivileges((await query(privilegeSql))[0]);
  const report = assessConnectPreflight({ caller, foundation, functionState,
    databaseRows: await query(databaseSql), loginRows: await query(loginSql),
    sessionRows: await query(sessionSql) });
  console.log(JSON.stringify({ ...report, sourceCommit, sqlSha256, committed: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error?.message ?? 'qualification_connect_preflight_failed'));
    process.exitCode = 1; });
}
