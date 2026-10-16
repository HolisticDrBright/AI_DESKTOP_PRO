/** Local, disposable two-session qualification of the BLOCKED legacy-claims-clinic-status successor, and of the clinic
 * check the UNREGISTERED current-membership setter already makes, for a clinic suspended while a request is in flight.
 *
 * PGlite has one connection, so it cannot show what happens when a clinic is suspended while another session is in the
 * middle of a clinical operation. This script starts a throwaway PostgreSQL cluster with no TCP listener (a private
 * Unix socket only) and two databases built from the assembled 106-migration production schema:
 *
 *   alp_parent  the deployed authority, no candidate: reproduces the gap natively;
 *   alp         the successor (legacy-claims-clinic-status.sql) and the setter (workforce-current-membership-context.sql).
 *
 * and drives two psql sessions through both race orders, for both authorities:
 *
 *   admitted first      an operation admitted into an active clinic holds the clinic row; a suspension waits for it to
 *                       commit, and the next request is refused;
 *   suspension pending  an operation asked for while an uncommitted suspension holds the clinic row waits, re-reads the
 *                       committed row, is refused, and writes nothing;
 *
 * plus an already-issued context after the suspension, reinstatement, cross-clinic requests, the active-clinic control
 * and the paths that stay open in a closed clinic (workforce consent management, consumer requests).
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-clinic-status-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { psqlSender } from './native-psql-session.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const bin = value('--binary-directory');
const runAs = value('--run-as');
const out = value('--out');
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('clinic_status_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('clinic_status_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('clinic_status_native_arguments_refused');
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql';
const SETTER = 'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`clinic_status_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-clinic-status-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'clinic-status-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidates are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'The two sessions call the SQL the services call; the services, tokens and Data API are not exercised here.',
] };
let started = false;
const sessions = [];
try {
  mkdirSync(socket);
  for (const path of [directory, socket]) {
    if (runAs) chownSync(path, Number(execFileSync('id', ['-u', runAs], { encoding: 'utf8' })), Number(execFileSync('id', ['-g', runAs], { encoding: 'utf8' })));
    chmodSync(path, 0o700);
  }
  report.postgres = run('postgres', ['--version']);
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c timezone=UTC -c max_connections=12`, '-w', '-t', '30', 'start']);
  started = true;
  const psql = (sql, database) => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (manifest.migrations.some((m) => /clinic-status|current-membership-context/.test(m.file))) throw Error('clinic_status_native_candidate_already_registered');

  // Fictional rows, the same in both databases: clinic A (the one suspended), clinic B (a sibling), a practitioner of A,
  // a practitioner of B only, a service identity for A's consent-management work, and a consumer.
  const ids = Object.fromEntries(['clinicA', 'clinicB', 'person', 'sub', 'stranger', 'strangerSub', 'service', 'serviceSub', 'consumer', 'consumerSub']
    .map((key) => [key, randomUUID()]));
  const seed = `insert into clinical_core.organizations(id,organization_label) values('${ids.clinicA}','FICTIONAL NATIVE A'),('${ids.clinicB}','FICTIONAL NATIVE B');
    insert into clinical_core.persons(id,subject_key) values ${[ids.person, ids.stranger, ids.service, ids.consumer].map((id) => `('${id}','subject_${id.replaceAll('-', '')}')`).join(',')};
    insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values
      ('${ids.person}','workforce','${ids.sub}',true),('${ids.stranger}','workforce','${ids.strangerSub}',true),
      ('${ids.service}','workforce','${ids.serviceSub}',true),('${ids.consumer}','consumer','${ids.consumerSub}',true);
    insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ('${ids.clinicA}','${ids.person}','practitioner'),('${ids.clinicB}','${ids.stranger}','practitioner'),('${ids.clinicA}','${ids.service}','staff');`;
  for (const [database, candidates] of [['alp_parent', []], ['alp', [SUCCESSOR, SETTER]]]) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(files[migration.file], database);
    for (const candidate of candidates) psql(readFileSync(join(root, candidate), 'utf8'), database);
    psql(seed, database);
  }

  const open = (name, database) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = psqlSender(child, name, 'clinic_status_native_session_timeout');
    const session = {
      send,
      child,
    };
    sessions.push(session);
    return session;
  };
  const waitingOnLock = async (name, database) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = psql(`select coalesce(wait_event_type,'') from pg_stat_activity where application_name='${name}' and state='active'`, database);
      if (state === 'Lock') return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const legacy = (person, sub, clinic, purpose = 'clinical_data', pool = 'workforce') =>
    `select clinical_private.set_request_context('${person}','${clinic}','${pool}','${sub}','${purpose}','production-clinical','clinical_phi') is null;`;
  const current = (sub, clinic) => `select clinical_private.set_current_workforce_context('${sub}','${clinic}','clinical_data') is not null;`;
  const create = (clinic) => `select clinical_core.create_patient_profile('${clinic}','Fictional','Native') is not null;`;
  const status = (clinic, value) => `update clinical_core.organizations set status='${value}' where id='${clinic}';`;
  const patients = (database, clinic) => Number(psql(`select count(*) from clinical_core.patient_records where organization_id='${clinic}'`, database));
  const begin = 'begin; set local role clinical_core_api;';
  /** A refusal the schema raises on purpose (SQLSTATE 42501 tokens), not some other error. */
  const REFUSAL = /\b(request_context_refused|workforce_membership_refused|production_context_refused|clinical_role_required)\b/;
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 120);
  let sequence = 0;
  const pair = (database) => { sequence += 1; return [open(`alp_cs_a${sequence}`, database), open(`alp_cs_b${sequence}`, database), `alp_cs_a${sequence}`, `alp_cs_b${sequence}`]; };
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  // The deployed authority, natively: a request after a committed suspension is still admitted and writes.
  {
    const entry = scenario('parent-admits-an-operation-after-the-clinic-is-suspended');
    const [a, b, aName] = pair('alp_parent');
    const before = patients('alp_parent', ids.clinicA);
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    await a.send(begin);
    const during = await a.send(`${legacy(ids.person, ids.sub, ids.clinicA)} ${create(ids.clinicA)}`);
    check(entry, !during.error, 'with the suspension uncommitted, the operation neither waits nor is refused');
    check(entry, !(await waitingOnLock(aName, 'alp_parent')), 'nothing holds it back');
    await a.send('commit;');
    await b.send('commit;');
    const after = await a.send(`${begin} ${legacy(ids.person, ids.sub, ids.clinicA)} ${create(ids.clinicA)} commit;`);
    check(entry, !after.error, 'after the suspension commits, an already-issued context is still admitted (the gap)');
    check(entry, patients('alp_parent', ids.clinicA) === before + 2, 'both writes landed in the suspended clinic');
    psql(status(ids.clinicA, 'active'), 'alp_parent');
    closeAll(a, b);
  }

  for (const [mode, admit, refusal] of [['legacy', (sub, clinic) => legacy(sub === ids.sub ? ids.person : ids.stranger, sub, clinic), /request_context_refused/],
    ['current', (sub, clinic) => current(sub, clinic), /workforce_membership_refused/]]) {
    // Admitted first: the operation holds the clinic row; the suspension waits for it, and the next request is refused.
    {
      const entry = scenario(`${mode}-admitted-operation-holds-off-the-suspension`);
      const [a, b, , bName] = pair('alp');
      const before = patients('alp', ids.clinicA);
      await a.send(begin);
      const admitted = await a.send(admit(ids.sub, ids.clinicA));
      check(entry, !admitted.error, `the ${mode} context is admitted into the active clinic${admitted.error ? `: ${admitted.error}` : ''}`);
      const pending = b.send(`begin; ${status(ids.clinicA, 'suspended')} commit;`);
      check(entry, await waitingOnLock(bName, 'alp'), 'the suspension waits on the clinic row the operation holds');
      const written = await a.send(create(ids.clinicA));
      check(entry, written.output === 't' && !written.error, 'the admitted write completes under the authority it was admitted with');
      await a.send('commit;');
      check(entry, !(await pending).error, 'the suspension commits after the operation commits');
      const next = await a.send(`${begin} ${admit(ids.sub, ids.clinicA)}`);
      check(entry, refusal.test(next.error), 'the next request, with the same already-issued identity, is refused');
      await a.send('rollback;');
      check(entry, patients('alp', ids.clinicA) === before + 1, 'exactly one write landed');
      psql(status(ids.clinicA, 'active'), 'alp');
      closeAll(a, b);
    }
    // Suspension pending: the operation waits on the uncommitted suspension, re-reads the committed row and is refused.
    {
      const entry = scenario(`${mode}-operation-waiting-on-a-pending-suspension-is-refused`);
      const [a, b, aName] = pair('alp');
      const before = patients('alp', ids.clinicA);
      await b.send(`begin; ${status(ids.clinicA, 'archived')}`);
      await a.send(begin);
      const pending = a.send(`${admit(ids.sub, ids.clinicA)} ${create(ids.clinicA)}`);
      check(entry, await waitingOnLock(aName, 'alp'), 'the operation waits on the clinic row the suspension holds');
      await b.send('commit;');
      const refused = await pending;
      check(entry, refusal.test(refused.error), 'after the suspension commits, the operation is refused');
      await a.send('rollback;');
      check(entry, patients('alp', ids.clinicA) === before, 'no partial write: no patient row');
      psql(status(ids.clinicA, 'active'), 'alp');
      closeAll(a, b);
    }
    // Cross-clinic: a practitioner of the sibling clinic naming this one, and this clinic's practitioner naming the sibling.
    {
      const entry = scenario(`${mode}-cross-clinic-requests-are-refused`);
      const [a, b] = pair('alp');
      const beforeA = patients('alp', ids.clinicA), beforeB = patients('alp', ids.clinicB);
      const intoA = await a.send(`${begin} ${admit(ids.strangerSub, ids.clinicA)} ${create(ids.clinicA)}`);
      check(entry, REFUSAL.test(intoA.error), `a practitioner of clinic B only cannot write into clinic A (${firstLine(intoA.error)})`);
      await a.send('rollback;');
      const intoB = await b.send(`${begin} ${admit(ids.sub, ids.clinicB)} ${create(ids.clinicB)}`);
      check(entry, REFUSAL.test(intoB.error), `a practitioner of clinic A only cannot write into clinic B (${firstLine(intoB.error)})`);
      await b.send('rollback;');
      check(entry, patients('alp', ids.clinicA) === beforeA && patients('alp', ids.clinicB) === beforeB, 'neither clinic gained a row');
      closeAll(a, b);
    }
  }

  // Already-issued context, reinstatement, the active-clinic control and the paths that stay open, under legacy claims.
  {
    const entry = scenario('legacy-already-issued-context-reinstatement-and-open-paths');
    const [a] = pair('alp');
    const before = patients('alp', ids.clinicA);
    const control = await a.send(`${begin} ${legacy(ids.person, ids.sub, ids.clinicA)} ${create(ids.clinicA)} commit;`);
    check(entry, !control.error, 'control: an active practitioner of an active clinic writes');
    psql(status(ids.clinicA, 'suspended'), 'alp');
    const stale = await a.send(`${begin} ${legacy(ids.person, ids.sub, ids.clinicA)} ${create(ids.clinicA)}`);
    check(entry, /request_context_refused/.test(stale.error), 'the same already-issued identity and clinic, after the suspension, is refused');
    await a.send('rollback;');
    const service = await a.send(`${begin} ${legacy(ids.service, ids.serviceSub, ids.clinicA, 'consent_management')} rollback;`);
    check(entry, !service.error, 'workforce consent management (retention, erasure, cleanup) still enters the closed clinic');
    const consumer = await a.send(`${begin} ${legacy(ids.consumer, ids.consumerSub, ids.clinicA, 'clinical_data', 'consumer')} rollback;`);
    check(entry, !consumer.error, 'a consumer request still enters the closed clinic');
    psql(status(ids.clinicA, 'active'), 'alp');
    const reinstated = await a.send(`${begin} ${legacy(ids.person, ids.sub, ids.clinicA)} ${create(ids.clinicA)} commit;`);
    check(entry, !reinstated.error, 'reinstating the clinic restores access: the suspension destroyed nothing');
    check(entry, patients('alp', ids.clinicA) === before + 2, 'exactly the control and the reinstated writes landed');
    closeAll(a);
  }
  report.passed = report.scenarios.every((entry) => entry.checks.every((c) => c.passed));
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
