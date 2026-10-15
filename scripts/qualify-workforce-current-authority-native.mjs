/** Local, disposable two-session qualification of the UNREGISTERED current-membership setter's lock order.
 *
 * PGlite has one connection, so it cannot show what happens when a membership is suspended while another session is
 * mid-operation. This script starts a throwaway PostgreSQL cluster with no TCP listener (a private Unix socket only),
 * loads the assembled production schema and the candidate, inserts fictional rows, and drives two psql sessions:
 *
 *   A. admitted first: a suspension issued while a consent grant holds the binding waits for that grant to commit,
 *      and the next request after the suspension is refused;
 *   B. suspended first: a binding requested while an uncommitted suspension holds the membership row waits, then
 *      re-reads the committed row and refuses;
 *   C. control: under the legacy claim setter the same suspension does not wait, so A and B measure the candidate's
 *      locks, not the harness.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-workforce-current-authority-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const bin = value('--binary-directory');
const runAs = value('--run-as');
const out = value('--out');
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('workforce_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('workforce_native_root_requires_run_as');
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`workforce_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-workforce-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'workforce-current-authority-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidate SQL is loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
] };
let started = false;
const sessions = [];
try {
  if (runAs) {
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('workforce_native_arguments_refused');
  }
  mkdirSync(socket);
  for (const path of [directory, socket]) {
    if (runAs) chownSync(path, Number(execFileSync('id', ['-u', runAs], { encoding: 'utf8' })), Number(execFileSync('id', ['-g', runAs], { encoding: 'utf8' })));
    chmodSync(path, 0o700);
  }
  report.postgres = run('postgres', ['--version']);
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c timezone=UTC -c max_connections=10`, '-w', '-t', '30', 'start']);
  started = true;
  const psql = (sql, database = 'alp') => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  psql('create database alp', 'postgres');
  psql('create extension if not exists pgcrypto');
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (manifest.migrations.some((m) => m.file.includes('current-membership-context'))) throw Error('workforce_native_candidate_already_registered');
  for (const migration of manifest.migrations) psql(files[migration.file]);
  psql(readFileSync(join(root, CANDIDATE), 'utf8'));

  const clinic = randomUUID(), person = randomUUID(), sub = randomUUID(), consumer = randomUUID(), consumerSub = randomUUID();
  const patient = randomUUID(), connection = randomUUID(), artifact = randomUUID();
  psql(`insert into clinical_core.organizations(id,organization_label) values('${clinic}','FICTIONAL NATIVE CLINIC');
    insert into clinical_core.persons(id,subject_key) values('${person}','subject_${person.replaceAll('-', '')}'),('${consumer}','subject_${consumer.replaceAll('-', '')}');
    insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${person}','workforce','${sub}',true),('${consumer}','consumer','${consumerSub}',true);
    insert into clinical_core.organization_memberships(organization_id,person_id,role) values('${clinic}','${person}','practitioner');
    insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values('${patient}','${clinic}','patient_${patient.replaceAll('-', '')}','Fictional','Patient');
    insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values('${connection}','${clinic}','${patient}','${consumer}','verified',clock_timestamp());
    insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values('${artifact}','${clinic}','forms_checkins','fictional-1','${'c'.repeat(64)}','US-FICTIONAL','approved',clock_timestamp(),'${person}');`);

  const open = (name) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', 'alp', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', marker = 0;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const session = {
      name, child,
      /** Sends SQL and resolves when psql has finished it (a marker echoed after it), with its output and errors. */
      send(sql) {
        const id = `__done_${name}_${++marker}__`;
        const startOut = output.length, startErr = errors.length;
        child.stdin.write(`${sql}\n\\echo ${id}\n`);
        return new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error(`workforce_native_session_timeout:${name}`)), 60_000);
          const check = () => {
            if (output.includes(id, startOut)) {
              clearTimeout(deadline); child.stdout.off('data', check);
              resolve({ output: output.slice(startOut, output.indexOf(id, startOut)).trim(), error: errors.slice(startErr).trim() });
            }
          };
          child.stdout.on('data', check); check();
        });
      },
      close() { child.stdin.end(); },
    };
    sessions.push(session);
    return session;
  };
  const waitingOnLock = async (name) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = psql(`select coalesce(wait_event_type,'') from pg_stat_activity where application_name='${name}' and state='active'`);
      if (state === 'Lock') return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const bind = `select clinical_private.set_current_workforce_context('${sub}','${clinic}','consent_management') is not null;`;
  const grant = `select status from clinical_core.record_consent_grant('${connection}','${artifact}','forms_checkins','in_person','self');`;
  const suspend = `update clinical_core.organization_memberships set status='suspended' where organization_id='${clinic}' and person_id='${person}';`;
  const reactivate = `update clinical_core.organization_memberships set status='active' where organization_id='${clinic}' and person_id='${person}';`;
  const grants = () => Number(psql(`select count(*) from clinical_core.consent_grants where connection_id='${connection}'`));
  const check = (scenario, condition, detail) => { scenario.checks.push({ detail, passed: Boolean(condition) }); };

  // A. Admitted first: the suspension waits for the admitted grant, and the next request is refused.
  {
    const scenario = { id: 'admitted-request-fences-suspension', checks: [] };
    const a = open('alp_native_a'), b = open('alp_native_b');
    await a.send('begin; set local role clinical_core_api;');
    const bound = await a.send(bind);
    check(scenario, bound.output === 't' && !bound.error, 'session A binds the current membership');
    const pending = b.send(`begin; ${suspend} commit;`);
    check(scenario, await waitingOnLock('alp_native_b'), 'session B suspension waits on the lock A holds');
    const granted = await a.send(grant);
    check(scenario, granted.output === 'granted' && !granted.error, 'session A grant is recorded under the binding it was admitted with');
    await a.send('commit;');
    const suspended = await pending;
    check(scenario, !suspended.error, 'session B suspension commits after A commits');
    const after = await a.send(`begin; set local role clinical_core_api; ${bind}`);
    check(scenario, /workforce_membership_refused/.test(after.error), 'the next request after the suspension is refused');
    await a.send('rollback;');
    check(scenario, grants() === 1, 'exactly one grant row exists');
    psql(reactivate);
    a.close(); b.close();
    report.scenarios.push(scenario);
  }

  // B. Suspended first: the binding waits for the uncommitted suspension, then refuses on the committed row.
  {
    const scenario = { id: 'pending-suspension-refuses-new-binding', checks: [] };
    const a = open('alp_native_a2'), b = open('alp_native_b2');
    const before = grants();
    await b.send(`begin; ${suspend}`);
    await a.send('begin; set local role clinical_core_api;');
    const pending = a.send(`${bind} ${grant}`);
    check(scenario, await waitingOnLock('alp_native_a2'), 'session A binding waits on the uncommitted suspension');
    await b.send('commit;');
    const refused = await pending;
    check(scenario, /workforce_membership_refused/.test(refused.error), 'session A re-reads the committed suspension and is refused');
    await a.send('rollback;');
    check(scenario, grants() === before, 'no grant row was written');
    psql(reactivate);
    a.close(); b.close();
    report.scenarios.push(scenario);
  }
  // C. Control: the legacy claim setter takes no membership lock, so the same suspension does not wait for it. This is
  // what makes A and B evidence of the candidate's lock order rather than of the test harness.
  {
    const scenario = { id: 'control-legacy-claim-context-does-not-fence', checks: [] };
    const a = open('alp_native_a3'), b = open('alp_native_b3');
    await a.send('begin; set local role clinical_core_api;');
    const legacy = await a.send(`select clinical_private.set_request_context('${person}','${clinic}','workforce','${sub}','consent_management','production-clinical','clinical_phi') is null;`);
    check(scenario, !legacy.error, `session A sets the legacy claim context${legacy.error ? `: ${legacy.error}` : ''}`);
    const suspended = await b.send(`begin; ${suspend} commit;`);
    check(scenario, !suspended.error, 'session B suspension commits at once, without waiting for session A');
    await a.send('rollback;');
    psql(reactivate);
    a.close(); b.close();
    report.scenarios.push(scenario);
  }
  report.passed = report.scenarios.every((scenario) => scenario.checks.every((entry) => entry.passed));
} catch (error) {
  const log = join(directory, 'server.log');
  if (existsSync(log)) process.stderr.write(readFileSync(log, 'utf8').slice(-2000));
  throw error;
} finally {
  for (const session of sessions) { try { session.child.kill(); } catch { /* already closed */ } }
  if (started) { try { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch { /* reported below */ } }
  rmSync(directory, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2) + '\n';
if (out) writeFileSync(out, text);
process.stdout.write(text);
if (!report.passed) process.exitCode = 1;
