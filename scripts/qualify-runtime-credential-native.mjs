/** Local source qualification only. Generated fictional cluster, real separate
 * PostgreSQL logins, actual adapter and metadata SQL. No AWS or provider client. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (process.platform !== 'win32' || args.length !== 4 || args[0] !== '--binary-directory'
  || args[2] !== '--driver-directory' || !isAbsolute(args[1]) || !isAbsolute(args[3])) throw Error('native_arguments_refused');
const bin = realpathSync(args[1]), driver = realpathSync(args[3]);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)
  || execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim())
  throw Error('native_source_not_frozen');
const require = createRequire(join(driver, 'package.json'));
const { Client } = require('pg');
const projectRequire = createRequire(join(root, 'package.json'));
const { buildSync } = projectRequire('esbuild');
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'].includes(name.toUpperCase())));
function run(name, args, stdio = 'pipe') {
  const result = spawnSync(join(bin, name + '.exe'), args, { env: childEnv, windowsHide: true, encoding: 'utf8',
    timeout: 60000, maxBuffer: 1024 * 1024, stdio });
  if (result.error || result.status !== 0) throw Error('native_process_failed_' + name);
  return (result.stdout ?? '').trim();
}
if (run('postgres', ['--version']) !== 'postgres (PostgreSQL) 17.7'
  || JSON.parse(readFileSync(join(driver, 'node_modules/pg/package.json'), 'utf8')).version !== '8.16.3') throw Error('native_versions_refused');
const runs = join(root, 'dist/runtime-credential-native'); mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(join(runs, 'pg17-'));
const bundle = join(directory, 'adapter.cjs');
buildSync({ entryPoints: [join(root, 'src/server/clinical-core/rds-data-database.ts')], outfile: bundle,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent' });
const { createRdsDataClinicalCoreDatabase, createRdsDataFullscriptDraftDatabase } = projectRequire(bundle);
const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
const data = join(directory, 'cluster'), passwordFile = join(directory, 'bootstrap-password');
const password = randomBytes(32).toString('hex');
writeFileSync(passwordFile, password + '\n', { flag: 'wx', mode: 0o600 });
const port = await new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
let started = false, bootstrap, shutdownConfirmed = false;
const results = [];
const configuration = { clusterArn: 'arn:aws:rds:us-east-2:123456789012:cluster:fictional-local',
  secretArn: 'arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional-local-AbCd12', databaseName: 'postgres' };
async function scenario(user, expected, factory = createRdsDataClinicalCoreDatabase, role = 'clinical_core_api') {
  const connection = new Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
  const commands = []; let callbackCalls = 0;
  await connection.connect();
  try {
    const transport = { async send(command) {
      const name = command.constructor.name.replace(/\d+$/, ''); commands.push(name);
      if (name === 'BeginTransactionCommand') { await connection.query('begin'); return { transactionId: 'fictional-native' }; }
      if (name === 'CommitTransactionCommand') { await connection.query('commit'); return {}; }
      if (name === 'RollbackTransactionCommand') { await connection.query('rollback'); return {}; }
      if (name !== 'ExecuteStatementCommand') throw Error('native_command_refused');
      const parameters = command.input.parameters ?? [];
      const sql = command.input.sql.replace(/:p(\d+)\b/g, (_match, n) => '$' + n);
      const values = parameters.map(p => p.value.stringValue);
      const result = await connection.query(sql, values);
      return { columnMetadata: result.fields.map(f => ({ name: f.name })),
        records: result.rows.map(row => result.fields.map(f => typeof row[f.name] === 'boolean'
          ? { booleanValue: row[f.name] } : { stringValue: String(row[f.name]) })) };
    } };
    let admitted = false;
    try {
      await factory(configuration, transport).transaction(async tx => {
        callbackCalls++;
        const row = (await tx.query('select current_user as effective_role, session_user as login_role')).rows[0];
        if (row.effective_role !== role || row.login_role !== user) throw Error('native_identity_refused');
      });
      admitted = true;
    } catch (error) {
      if (expected || error?.name !== 'RdsDataDatabaseError' || error.category !== 'configuration_invalid') throw Error('native_unexpected_refusal');
    }
    if (admitted !== expected || callbackCalls !== (expected ? 1 : 0)
      || commands.at(-1) !== (expected ? 'CommitTransactionCommand' : 'RollbackTransactionCommand')) throw Error('native_verdict_refused');
    results.push({ user, role, admitted, callbackCalls, transactionSettled: true });
  } finally { await connection.end(); }
}
try {
  run('initdb', ['-D', data, '-U', 'bootstrap', '--pwfile', passwordFile, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--no-locale']);
  unlinkSync(passwordFile);
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port, '-w', 'start'], 'ignore'); started = true;
  bootstrap = new Client({ host: '127.0.0.1', port, user: 'bootstrap', password, database: 'postgres' }); await bootstrap.connect();
  // Administration is confined to generated local fixtures, never an application session.
  await bootstrap.query(`create role clinical_admin login createrole createdb nosuperuser nobypassrls password '${password}';
    create role clinical_core_api nologin; create role fullscript_draft_worker nologin;
    create role fictional_runtime login noinherit password '${password}';
    create role fictional_worker login noinherit password '${password}';
    grant clinical_core_api to clinical_admin; grant clinical_core_api to fictional_runtime with inherit false,set true;
    grant fullscript_draft_worker to fictional_worker with inherit false,set true;
    create schema fictional_records authorization clinical_admin;
    grant usage on schema fictional_records to clinical_core_api, fullscript_draft_worker`);
  await scenario('fictional_runtime', true);
  await scenario('fictional_worker', true, createRdsDataFullscriptDraftDatabase, 'fullscript_draft_worker');
  await scenario('fictional_worker', false);
  await scenario('fictional_runtime', false, createRdsDataFullscriptDraftDatabase, 'fullscript_draft_worker');
  await scenario('clinical_admin', false);
  await bootstrap.query('grant clinical_admin to fictional_runtime with inherit false,set false');
  await scenario('fictional_runtime', false);
  await bootstrap.query('revoke clinical_admin from fictional_runtime');
  await scenario('fictional_runtime', true);
} finally {
  if (bootstrap) await bootstrap.end();
  if (started) {
    run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], 'ignore');
    shutdownConfirmed = spawnSync(join(bin, 'pg_ctl.exe'), ['-D', data, 'status'],
      { env: childEnv, windowsHide: true, stdio: 'ignore', timeout: 10000 }).status === 3;
  }
  const report = { contract: 'runtime-credential-native-source/1', sourceCommit, bundleSha256, postgresVersion: '17.7',
    results, shutdownConfirmed, sourceOnly: true, hostedQualified: false, providerQualified: false, phiAllowed: false, activation: 'blocked' };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
if (!shutdownConfirmed || results.length !== 7) throw Error('native_qualification_incomplete');
console.log(JSON.stringify({ report: join(directory, 'report.json'), sourceCommit, passed: results.length, shutdownConfirmed, phiAllowed: false }));
