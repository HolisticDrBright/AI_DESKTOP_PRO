/** Fictional-only, exact-source operator. Never use for production or PHI. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import {
  RDSDataClient, BeginTransactionCommand, CommitTransactionCommand,
  ExecuteStatementCommand, RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';

const ACCOUNT = '588966314750';
const REGION = 'us-east-2';
// The staging profile resolves to root in this account. Use the reviewed
// assumed-role profile for operator commands, including read-only inspection.
const PROFILE = 'ai-synthetic-member';
const DATABASE = 'clinical_core_qualification';
const FOUNDATION = 'ai-clinical-core-qualification-foundation';
const FUNCTION = '6zt8e9qz04-qualification-bound-programs';
const DATABASE_INVENTORY = Object.freeze([
  'alp_chat_rls_synthetic_v1', 'clinical_core', DATABASE, 'postgres',
]);
const RELEASE = '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4';
const SQL_PATH = 'infra/aws-clinical-core/source-candidates/qualification-program-api-login.sql';
const SQL_SHA256 = '7b8541f9c647b13decfef5e7fa42b1d96cab488b7ea91fc5a772d8f5520b2d6f';
// The sole fictional program/assignment was created after the original
// zero-row operator. Preserve it byte-for-byte; never relax this to an
// arbitrary nonzero row count or use a destructive cleanup to regain zero.
const FIXTURE = Object.freeze({
  programId: 'a60c16af-77bf-47e1-900c-5c6cada9bcdf',
  versionId: '2fd15312-3256-42bb-9131-e34fbf5a2656',
  versionContentSha256: '3bb72b61c33e6d595d068b2b47e49a0f8ff5379aac93073c35b7f924e67e0c57',
  assignmentId: '4ad10ac1-7855-4999-907e-82c723fb63d2',
  connectionId: '1e6b5f97-1021-4922-a5fe-04e5f5e798b0',
  sourceDigest: '7f5a03b4d075abe00f2a1b9e5bb171b4b7be0b5620ee023a163c369bbed243fd',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = reason => { throw new Error(`qualification_credential_refused:${reason}`); };
const check = (condition, reason) => { if (!condition) refuse(reason); };
const stripComments = statement => statement.replace(/--[^\r\n]*/g, '').trim().toLowerCase();

/** The literal file delimiters are replaced by one RDS Data API transaction. */
export function credentialStatements(sql, splitPostgresStatements) {
  check(sha(sql.replace(/\r\n/g, '\n')) === SQL_SHA256, 'sql_hash');
  const statements = splitPostgresStatements(sql);
  check(statements.length >= 5 && stripComments(statements[0]) === 'begin'
    && stripComments(statements.at(-1)) === 'commit', 'transaction_delimiters');
  const interior = statements.slice(1, -1);
  check(interior.every(statement => !['begin', 'commit', 'rollback'].includes(stripComments(statement))), 'nested_transaction');
  check(interior.some(statement => statement.includes('create role clinical_program_qualification_api'))
    && interior.some(statement => statement.includes('revoke all on function clinical_program_qualification.bounded_request')),
  'candidate_incomplete');
  return interior;
}

const snapshotSql = `select current_database() as database,
 (select count(*)::int from clinical_core.schema_migrations) as migration_count,
 (select encode(sha256(convert_to(string_agg(version||':'||sha256,E'\\n' order by version),'UTF8')),'hex')
   from clinical_core.schema_migrations) as release_sha256,
 (select count(*)::int from pg_roles where rolname in
   ('clinical_program_qualification_api','clinical_program_qualification_login')) as role_count,
 (select count(*)::int from pg_namespace where nspname='clinical_program_qualification') as schema_count,
 (select count(*)::int from clinical_core.programs) as program_count,
 (select count(*)::int from clinical_core.program_versions) as version_count,
 (select count(*)::int from clinical_core.program_versions where status='published') as published_count,
 (select count(*)::int from clinical_core.program_assignments) as assignment_count,
 (select count(*)::int from clinical_core.programs p
   join clinical_core.program_versions v on v.program_id=p.id and v.organization_id=p.organization_id
   join clinical_core.program_assignments a on a.program_version_id=v.id and a.organization_id=p.organization_id
   join clinical_core.patient_connections c on c.id=a.connection_id and c.organization_id=p.organization_id
   where p.id='${FIXTURE.programId}'::uuid and p.status='active' and p.active_version_id=v.id
     and v.id='${FIXTURE.versionId}'::uuid and v.status='published'
     and v.content_sha256='${FIXTURE.versionContentSha256}'
     and encode(sha256(convert_to(v.content::text,'UTF8')),'hex')='${FIXTURE.versionContentSha256}'
     and a.id='${FIXTURE.assignmentId}'::uuid and a.state='offered'
     and a.source_digest='${FIXTURE.sourceDigest}'
     and c.id='${FIXTURE.connectionId}'::uuid and c.state='verified') as fixture_count,
 (select encode(sha256(convert_to(jsonb_build_object(
   'programs',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from clinical_core.programs p),
   'versions',(select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]'::jsonb) from clinical_core.program_versions v),
   'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb) from clinical_core.program_assignments a),
   'connections',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb)
     from clinical_core.patient_connections c where c.id='${FIXTURE.connectionId}'::uuid)
 )::text,'UTF8')),'hex')) as custody_sha256,
 (select count(*)::int from clinical_core.program_qualification_subjects) as designated_count,
 (select enabled from clinical_core.program_qualification_boundary) as qualification_enabled,
 (select enabled from clinical_core.production_program_activation) as production_enabled,
 (select enabled from clinical_core.program_consumer_boundary_activation) as consumer_enabled`;

export const privilegeSql = `select
 (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='clinical_program_qualification') as proxy_count,
 (select count(*)::int from pg_roles where rolname in
   ('clinical_program_qualification_api','clinical_program_qualification_login')
   and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb
   and not rolcreaterole and not rolreplication and not rolbypassrls) as safe_role_count,
 (select count(*)::int from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
   join pg_roles member on member.oid=m.member
   where parent.rolname='clinical_program_qualification_api'
     and member.rolname='clinical_program_qualification_login'
     and not m.admin_option and not m.inherit_option and m.set_option) as membership_count,
 (select count(*)::int from pg_auth_members m join pg_roles parent on parent.oid=m.roleid
   join pg_roles member on member.oid=m.member
   where parent.rolname like 'clinical_program_qualification_%'
      or member.rolname like 'clinical_program_qualification_%') as total_memberships,
 (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='clinical_program_qualification' and p.prosecdef
     and p.proconfig=array['search_path=""']::text[]
     and ((p.oid=to_regprocedure('clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)')
       and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='23cb89c1a12f2b2fce4bb13be7e9d34f9759990b1a0afee5470fc22855668215')
       or (p.oid=to_regprocedure('clinical_program_qualification.bounded_request(jsonb)')
       and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='7f712320f522c958fb6946685de7be8a3004af9ea89acfb0a467a7bbbe0b78df'))) as intact_proxy_count,
 (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   where n.nspname='clinical_program_qualification' and acl.grantee=0
     and acl.privilege_type='EXECUTE') as public_proxy_execute_count,
 has_schema_privilege('clinical_program_qualification_api','clinical_core','USAGE') as core_usage,
 has_schema_privilege('clinical_program_qualification_api','clinical_private','USAGE') as private_usage,
 has_schema_privilege('clinical_program_qualification_api','clinical_program_qualification','USAGE') as proxy_usage,
 has_function_privilege('clinical_program_qualification_api',
   'clinical_program_qualification.bounded_request(jsonb)','EXECUTE') as bounded_execute,
 has_function_privilege('clinical_program_qualification_api',
   'clinical_program_qualification.set_request_context(uuid,uuid,text,text,text,text,text)','EXECUTE') as context_execute`;

export const crossDatabasePrivilegeSql = `select current_database() as database,
 has_database_privilege('clinical_program_qualification_login',current_database(),'CONNECT') as login_connect,
 has_database_privilege('clinical_program_qualification_api',current_database(),'CONNECT') as api_connect,
 (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where c.relkind in ('r','v','m','p','f') and n.nspname not in ('pg_catalog','information_schema')
     and n.nspname not like 'pg_%' and has_schema_privilege('clinical_program_qualification_api',n.oid,'USAGE')
     and has_table_privilege('clinical_program_qualification_api',c.oid,'SELECT')) as api_readable_relations,
 (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where p.prosecdef and n.nspname not in ('pg_catalog','information_schema')
     and n.nspname not like 'pg_%' and has_schema_privilege('clinical_program_qualification_api',n.oid,'USAGE')
     and has_function_privilege('clinical_program_qualification_api',p.oid,'EXECUTE')) as api_callable_security_definers`;

export function assessCrossDatabaseIsolation(rows) {
  check(Array.isArray(rows) && rows.length === DATABASE_INVENTORY.length
    && rows.every((row, index) => row?.database === DATABASE_INVENTORY[index]
      && typeof row.login_connect === 'boolean' && typeof row.api_connect === 'boolean'
      && Number.isInteger(row.api_readable_relations) && row.api_readable_relations >= 0
      && Number.isInteger(row.api_callable_security_definers) && row.api_callable_security_definers >= 0),
  'database_inventory_changed');
  const qualification = rows.find(row => row.database === DATABASE);
  check(qualification.api_readable_relations === 0
    && qualification.api_callable_security_definers === 2, 'qualification_privilege_drift');
  const siblings = rows.filter(row => row.database !== DATABASE);
  return { isolated: siblings.every(row => !row.login_connect && !row.api_connect
      && row.api_readable_relations === 0 && row.api_callable_security_definers === 0),
    databases: rows.map(row => ({ database: row.database, loginConnect: row.login_connect,
      apiConnect: row.api_connect, apiReadableRelations: row.api_readable_relations,
      apiCallableSecurityDefiners: row.api_callable_security_definers })) };
}

export function assertSnapshot(row, installed, expectedCustody) {
  check(row?.database === DATABASE && row.migration_count === 112 && row.release_sha256 === RELEASE,
    'database_or_ledger');
  check(row.role_count === (installed ? 2 : 0) && row.schema_count === (installed ? 1 : 0),
    'candidate_state');
  check(row.program_count === 1 && row.version_count === 1 && row.published_count === 1
    && row.assignment_count === 1 && row.fixture_count === 1
    && /^[a-f0-9]{64}$/.test(row.custody_sha256 ?? '')
    && (expectedCustody === undefined || row.custody_sha256 === expectedCustody)
    && row.designated_count === 3 && row.qualification_enabled === true
    && row.production_enabled === false && row.consumer_enabled === false, 'fixture_or_activation');
}

export function assertPrivileges(row) {
  check(row?.proxy_count === 2 && row.safe_role_count === 2 && row.membership_count === 1
    && row.total_memberships === 1 && row.intact_proxy_count === 2 && row.public_proxy_execute_count === 0
    && row.core_usage === false && row.private_usage === false && row.proxy_usage === true
    && row.bounded_execute === true && row.context_execute === true, 'privileges');
}

function aws(...args) {
  return JSON.parse(execFileSync('aws', [...args, '--profile', PROFILE, '--region', REGION, '--output', 'json'],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

async function canonicalSplitter() {
  mkdirSync('dist/qualification-program-credential', { recursive: true });
  await build({ entryPoints: ['src/server/clinical-core/migrations.ts'],
    outfile: 'dist/qualification-program-credential/migrations.cjs', bundle: true,
    platform: 'node', format: 'cjs', logLevel: 'silent' });
  return createRequire(import.meta.url)('../dist/qualification-program-credential/migrations.cjs')
    .splitPostgresStatements;
}

async function main() {
  const [mode, approvalDigest] = process.argv.slice(2);
  check(['inspect', 'inspect-installed', 'audit-isolation', 'rehearse', 'apply'].includes(mode), 'command');
  check(mode === 'apply' ? approvalDigest === SQL_SHA256 : approvalDigest === undefined, 'approval_argument');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  check(/^[a-f0-9]{40}$/.test(sourceCommit)
    && !execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8', windowsHide: true }).trim(), 'dirty_source');
  const statements = credentialStatements(readFileSync(SQL_PATH, 'utf8'), await canonicalSplitter());
  const caller = aws('sts', 'get-caller-identity');
  check(caller.Account === ACCOUNT && String(caller.Arn ?? '').startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/`), 'account');
  const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', FOUNDATION).Stacks?.[0];
  const outputs = Object.fromEntries((foundation?.Outputs ?? []).map(output => [output.OutputKey, output.OutputValue]));
  check(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(foundation?.StackStatus)
    && outputs.DatabaseName === DATABASE && outputs.PhiAllowed === 'false'
    && outputs.Activation === 'blocked' && outputs.DataClassification === 'synthetic_only'
    && outputs.DatabaseClusterArn?.startsWith(`arn:aws:rds:${REGION}:${ACCOUNT}:cluster:`)
    && outputs.DatabaseSecretArn?.startsWith(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!cluster-`),
  'foundation');
  const functionState = aws('lambda', 'get-function-configuration', '--function-name', FUNCTION);
  const variables = functionState.Environment?.Variables ?? {};
  check(functionState.State === 'Active' && functionState.LastUpdateStatus === 'Successful'
    && variables.PHI_ALLOWED === 'false' && variables.PROGRAM_ACTIVATION === 'blocked'
    && variables.CLINICAL_DATABASE_NAME === DATABASE && variables.MIGRATION_RELEASE_SHA256 === RELEASE
    && variables.CLINICAL_DATABASE_CLUSTER_ARN === outputs.DatabaseClusterArn
    && variables.CLINICAL_DATABASE_SECRET_ARN === outputs.DatabaseSecretArn, 'lambda_posture');
  const common = { resourceArn: outputs.DatabaseClusterArn, secretArn: outputs.DatabaseSecretArn, database: DATABASE };
  const client = new RDSDataClient({ region: REGION, credentials: fromIni({ profile: PROFILE }), maxAttempts: 1 });
  const query = async (sql, transactionId, database = DATABASE) => {
    const response = await client.send(new ExecuteStatementCommand({ ...common, database, transactionId,
      sql, formatRecordsAs: 'JSON' }));
    return JSON.parse(response.formattedRecords ?? '[]');
  };
  const snapshot = async transactionId => (await query(snapshotSql, transactionId))[0];
  const before = await snapshot();
  const installedInspection = mode === 'inspect-installed' || mode === 'audit-isolation';
  assertSnapshot(before, installedInspection);
  if (installedInspection) assertPrivileges((await query(privilegeSql))[0]);
  const custody = before.custody_sha256;
  const result = { contract: 'qualification-program-credential-operator/1', mode, accountId: ACCOUNT,
    region: REGION, database: DATABASE, sourceCommit, sqlSha256: SQL_SHA256,
    statementCount: statements.length, phiAllowed: false, productionActivation: 'blocked', committed: false };
  if (mode === 'inspect' || installedInspection) {
    if (mode === 'audit-isolation') {
      const inventory = await query("select datname as database from pg_database where datallowconn and not datistemplate and datname <> 'rdsadmin' order by datname");
      check(inventory.length === DATABASE_INVENTORY.length
        && inventory.every((row, index) => row.database === DATABASE_INVENTORY[index]),
      'database_inventory_changed');
      const rows = [];
      for (const database of DATABASE_INVENTORY) {
        const observation = await query(crossDatabasePrivilegeSql, undefined, database);
        check(observation.length === 1, 'database_observation');
        rows.push(observation[0]);
      }
      const assessment = assessCrossDatabaseIsolation(rows);
      console.log(JSON.stringify({ ...result, installed: true, ...assessment }));
      if (!assessment.isolated) process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify({ ...result, installed: installedInspection }));
    return;
  }
  const transactionId = (await client.send(new BeginTransactionCommand(common))).transactionId;
  check(typeof transactionId === 'string' && transactionId.length > 0, 'transaction_missing');
  let commitAttempted = false;
  try {
    await query("select pg_advisory_xact_lock(hashtext('alp:qualification-program-credential'))", transactionId);
    assertSnapshot(await snapshot(transactionId), false, custody);
    for (const statement of statements) await query(statement, transactionId);
    assertSnapshot(await snapshot(transactionId), true, custody);
    assertPrivileges((await query(privilegeSql, transactionId))[0]);
    if (mode === 'rehearse') {
      await client.send(new RollbackTransactionCommand({ ...common, transactionId }));
      assertSnapshot(await snapshot(), false, custody);
      console.log(JSON.stringify({ ...result, rehearsalRolledBack: true }));
      return;
    }
    commitAttempted = true;
    await client.send(new CommitTransactionCommand({ ...common, transactionId }));
    assertSnapshot(await snapshot(), true, custody);
    assertPrivileges((await query(privilegeSql))[0]);
    console.log(JSON.stringify({ ...result, committed: true }));
  } catch (error) {
    if (!commitAttempted) {
      try { await client.send(new RollbackTransactionCommand({ ...common, transactionId })); }
      catch { /* Preserve the original error; the operator must inspect before any retry. */ }
    }
    if (commitAttempted) refuse('commit_outcome_uncertain_manual_inspection_required');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error?.message ?? 'qualification_credential_failed'));
    process.exitCode = 1; });
}
