/**
 * Two-session native qualification of the BLOCKED workforce-ordinary-suspension-window successor on a real PostgreSQL
 * 16 server: an ordinary clinic suspension racing a practitioner session's reads and writes, the token's expiry checked
 * after a lock wait, lock waits bounded by the time the window has left, an emergency revocation inside the window, and
 * the sibling clinic, on the production schema (scripts/build-aws-production-clinical-core.mjs) with the candidate's
 * parent chain (the platform-operator chain and the emergency revocation).
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-ordinary-suspension-window-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('suspension_window_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('suspension_window_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('suspension_window_native_arguments_refused');
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
  'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql',
];
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-ordinary-suspension-window.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`suspension_window_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-suspension-window-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'ordinary-suspension-window-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidate and its parents are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'Token times are fictional NumericDate values the sessions pass as the services would from verified claims; no token is signed, verified or issued, and Cognito, the authorizer and the Data API are not exercised.',
  'The database clock and the clock that computes the fictional token times are the same host clock here; in AWS they are Cognito\'s and Aurora\'s.',
] };
let started = false;
const sessions = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  mkdirSync(socket);
  for (const path of [directory, socket]) {
    if (runAs) chownSync(path, Number(execFileSync('id', ['-u', runAs], { encoding: 'utf8' })), Number(execFileSync('id', ['-g', runAs], { encoding: 'utf8' })));
    chmodSync(path, 0o700);
  }
  report.postgres = run('postgres', ['--version']);
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c timezone=UTC -c max_connections=16`, '-w', '-t', '30', 'start']);
  started = true;
  const psql = (sql, database = 'alp') => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (manifest.migrations.some((m) => /suspension-window/.test(m.file))) throw Error('suspension_window_native_candidate_already_registered');

  // `alp` carries the candidate; `alp_parent` stops at its parent (the emergency revocation), to show the gap.
  for (const database of ['alp', 'alp_parent']) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(files[migration.file], database);
    for (const file of database === 'alp' ? [...CHAIN, CANDIDATE] : CHAIN) psql(readFileSync(join(root, file), 'utf8'), database);
  }
  report.entries = Object.fromEntries(['alp', 'alp_parent'].map((database) => [database,
    psql(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')`, database)]));
  const operator = randomUUID();
  psql(`insert into clinical_private.workforce_platform_operators(operator_subject,status) values('${operator}','active');
    update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='independent_review_after' where singleton;`);

  /** Two fresh fictional clinics (A and its sibling B), a patient in each, and a practitioner who is a member of both. */
  const world = (database = 'alp') => {
    const w = { clinicA: randomUUID(), clinicB: randomUUID(), patientA: randomUUID(), patientB: randomUUID(), person: randomUUID(), subject: randomUUID() };
    psql(`insert into clinical_core.organizations(id,organization_label) values('${w.clinicA}','FICTIONAL NATIVE A'),('${w.clinicB}','FICTIONAL NATIVE B');
      insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values
        ('${w.patientA}','${w.clinicA}','patient_${w.patientA.replaceAll('-', '')}','Fictional','Native'),
        ('${w.patientB}','${w.clinicB}','patient_${w.patientB.replaceAll('-', '')}','Fictional','Native');
      insert into clinical_core.persons(id,subject_key) values('${w.person}','subject_${w.person.replaceAll('-', '')}');
      insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${w.person}','workforce','${w.subject}',true);
      insert into clinical_core.organization_memberships(organization_id,person_id,role) values('${w.clinicA}','${w.person}','practitioner'),('${w.clinicB}','${w.person}','practitioner');`, database);
    return w;
  };
  const open = (name, database = 'alp') => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { send: psqlSender(child, name, 'suspension_window_native_session_timeout'), child, name };
    sessions.push(session);
    return session;
  };
  const waitingOnLock = async (name, database = 'alp') => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (psql(`select coalesce(wait_event_type,'') from pg_stat_activity where application_name='${name}' and state='active'`, database) === 'Lock') return true;
      await pause(50);
    }
    return false;
  };
  let sequence = 0;
  const sessionsFor = (count, database = 'alp') => Array.from({ length: count }, () => { sequence += 1; return open(`alp_sw_${sequence}`, database); });
  const begin = 'begin; set local role clinical_core_api;';
  const seconds = () => Math.floor(Date.now() / 1000);
  /** A token as Cognito would issue it, issued `ago` seconds before now, valid for `lifetime` seconds. */
  const token = (ago, lifetime = 3600) => { const iat = seconds() - ago; return { iat, exp: iat + lifetime }; };
  const seven = (w, clinic) =>
    `select clinical_private.set_request_context('${w.person}','${clinic}','workforce','${w.subject}','clinical_data','production-clinical','clinical_phi') is null;`;
  const ten = (w, clinic, t, access = 'read') =>
    `select clinical_private.set_request_context('${w.person}','${clinic}','workforce','${w.subject}','clinical_data','production-clinical','clinical_phi',${t.iat},${t.exp},'${access}') is null;`;
  const readPatient = (patient) => `select count(*) from clinical_core.patient_records where id='${patient}';`;
  const writePatient = (clinic, last) => `select clinical_core.create_patient_profile('${clinic}','Fictional','${last}') is not null;`;
  const suspend = (clinic) => `begin; update clinical_core.organizations set status='suspended' where id='${clinic}';`;
  const profiles = (last, database = 'alp') => psql(`select count(*) from clinical_core.patient_records where last_name='${last}'`, database);
  const REFUSED = /\brequest_context_refused\b/;
  const last = (result) => result.output.split('\n').pop();
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 140);
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  // Failing-before, on the parent: after an ordinary suspension a refreshed token reads and writes, and the database
  // cannot tell it from the session that was open before; no token time reaches it.
  {
    const entry = scenario('on-the-parent-a-token-refreshed-after-the-suspension-reads-and-writes');
    const w = world('alp_parent');
    const tag = `Native${randomUUID().slice(0, 8)}`;
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinicA}'`, 'alp_parent');
    const [a] = sessionsFor(1, 'alp_parent');
    const read = await a.send(`${begin} ${seven(w, w.clinicA)} ${readPatient(w.patientA)} commit;`);
    check(entry, last(read) === '1' && !read.error, 'DEFECT on the parent: the suspended clinic\'s patient is read');
    const wrote = await a.send(`${begin} ${seven(w, w.clinicA)} ${writePatient(w.clinicA, tag)} commit;`);
    check(entry, !wrote.error && profiles(tag, 'alp_parent') === '1', 'DEFECT on the parent: a new patient is written into the suspended clinic');
    check(entry, psql("select to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text,bigint,bigint,text)') is null", 'alp_parent') === 't',
      'the parent has no entry that could carry a token time');
    closeAll(a);
  }

  // A suspension in flight: a request waits on the clinic row, then re-reads the committed suspension. A token issued
  // before it is admitted read-only; one issued while it was in flight (a refresh) is refused.
  {
    const entry = scenario('a-request-waiting-on-a-suspension-in-flight-re-reads-it');
    const w = world();
    const before = token(600);
    const [a, b, c] = sessionsFor(3);
    await b.send(suspend(w.clinicA));
    const during = token(0);
    await a.send(begin);
    const old = a.send(`${ten(w, w.clinicA, before)} ${readPatient(w.patientA)} select current_setting('transaction_read_only');`);
    await c.send(begin);
    const fresh = c.send(`${ten(w, w.clinicA, during)} ${readPatient(w.patientA)}`);
    check(entry, await waitingOnLock(a.name) && await waitingOnLock(c.name), 'both requests wait on the clinic row the suspension holds');
    await b.send('commit;');
    const oldResult = await old, freshResult = await fresh;
    check(entry, !oldResult.error && oldResult.output.split('\n').slice(-2).join(',') === '1,on',
      `the token issued before the suspension is admitted, read-only (${oldResult.output.replace(/\n/g, ',')}${oldResult.error ? `; ${firstLine(oldResult.error)}` : ''})`);
    check(entry, REFUSED.test(freshResult.error), `the token issued while the suspension was in flight is refused (${firstLine(freshResult.error)})`);
    await a.send('rollback;');
    await c.send('rollback;');
    closeAll(a, b, c);
  }

  // Admitted first: a request in an active clinic holds the clinic row; the suspension waits for it to finish.
  {
    const entry = scenario('an-admitted-request-holds-off-the-suspension');
    const w = world();
    const tag = `Native${randomUUID().slice(0, 8)}`;
    const [a, b] = sessionsFor(2);
    await a.send(`${begin} ${ten(w, w.clinicA, token(60), 'write')}`);
    const wrote = await a.send(writePatient(w.clinicA, tag));
    check(entry, wrote.output === 't' && !wrote.error, 'the admitted write is made in the active clinic');
    const pending = b.send(`${suspend(w.clinicA)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the suspension waits on the row the admitted request holds');
    await a.send('commit;');
    check(entry, !(await pending).error, 'the suspension commits after the request commits');
    check(entry, profiles(tag) === '1', 'the write committed before the suspension did');
    const after = await a.send(`${begin} ${ten(w, w.clinicA, token(0), 'write')} ${writePatient(w.clinicA, tag)}`);
    check(entry, REFUSED.test(after.error), `a request with a token issued after the suspension is refused (${firstLine(after.error)})`);
    await a.send('rollback;');
    closeAll(a, b);
  }

  // The expiry is read from the statement clock after the lock wait: a token that expires while it waits is refused.
  {
    const entry = scenario('a-token-that-expires-while-waiting-on-the-suspension-is-refused');
    const w = world();
    const short = token(297, 300); // issued 297 s ago, a 5-minute token: about 3 s left
    const [a, b] = sessionsFor(2);
    await b.send(suspend(w.clinicA));
    await a.send(begin);
    const waiting = a.send(`${ten(w, w.clinicA, short)} ${readPatient(w.patientA)}`);
    check(entry, await waitingOnLock(a.name), 'the request waits on the suspension in flight');
    await pause(Math.max(0, short.exp * 1000 - Date.now()) + 1500);
    await b.send('commit;');
    const refused = await waiting;
    check(entry, REFUSED.test(refused.error), `when it is let through, its token has expired and it is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    closeAll(a, b);
  }

  // Inside the window a statement's lock wait cannot run past the token's expiry.
  {
    const entry = scenario('a-lock-wait-inside-the-window-ends-at-the-expiry');
    const w = world();
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinicA}'`);
    const short = token(296, 300); // about 4 s left
    const [a, c] = sessionsFor(2);
    await c.send('begin; lock table clinical_core.patient_records in access exclusive mode;');
    const admitted = await a.send(`${begin} ${ten(w, w.clinicA, short)}`);
    check(entry, !admitted.error, `the session issued before the suspension is admitted${admitted.error ? ` (${firstLine(admitted.error)})` : ''}`);
    const started = Date.now();
    const blocked = await a.send(readPatient(w.patientA));
    const waited = Date.now() - started;
    check(entry, /lock timeout|statement timeout/.test(blocked.error) && waited < 10_000,
      `its read, waiting on another session's lock, is cancelled at the window's end after ${waited} ms (${firstLine(blocked.error)})`);
    await a.send('rollback;');
    await c.send('rollback;');
    closeAll(a, c);
  }

  // A write in the window: declared, it is held; sent as a read, the read-only transaction refuses it.
  {
    const entry = scenario('in-the-window-nothing-is-written');
    const w = world();
    const tag = `Native${randomUUID().slice(0, 8)}`;
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinicA}'`);
    const before = token(600);
    const [a] = sessionsFor(1);
    const held = await a.send(`${begin} ${ten(w, w.clinicA, before, 'write')} ${writePatient(w.clinicA, tag)}`);
    check(entry, /\bordinary_suspension_write_held\b/.test(held.error), `a declared write is held (${firstLine(held.error)})`);
    await a.send('rollback;');
    const disguised = await a.send(`${begin} ${ten(w, w.clinicA, before, 'read')} ${writePatient(w.clinicA, tag)}`);
    check(entry, /read-only transaction/.test(disguised.error), `a write sent as a read is refused by the read-only transaction (${firstLine(disguised.error)})`);
    await a.send('rollback;');
    check(entry, profiles(tag) === '0', 'nothing was written');
    closeAll(a);
  }

  // A suspected compromise inside the window: the revocation is refused at once, and a request racing it waits for it.
  {
    const entry = scenario('an-emergency-revocation-ends-the-window-at-once');
    const w = world();
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinicA}'`);
    const before = token(600);
    const [a, b] = sessionsFor(2);
    const read = await a.send(`${begin} ${ten(w, w.clinicA, before)} ${readPatient(w.patientA)} commit;`);
    check(entry, last(read) === '1' && !read.error, 'within the window the session reads');
    await b.send(`begin; set local role clinical_workforce_operator; select clinical_private.propose_workforce_identity_revocation('${operator}','${randomUUID()}','${w.subject}','suspected_compromise') is not null;`);
    await a.send(begin);
    const racing = a.send(`${ten(w, w.clinicA, before)} ${readPatient(w.patientA)}`);
    check(entry, await waitingOnLock(a.name), 'a request arriving during the pending revocation waits on the identity row');
    await b.send('commit;');
    const refused = await racing;
    check(entry, REFUSED.test(refused.error), `then it is refused, though its window has not ended (${firstLine(refused.error)})`);
    await a.send('rollback;');
    closeAll(a, b);
  }

  // The sibling clinic: a suspension of A in flight does not hold back B, and B is not suspended by it.
  {
    const entry = scenario('the-sibling-clinic-is-not-held-back');
    const w = world();
    const tag = `Native${randomUUID().slice(0, 8)}`;
    const [a, b] = sessionsFor(2);
    await b.send(suspend(w.clinicA));
    const wrote = await a.send(`${begin} ${ten(w, w.clinicB, token(0), 'write')} ${writePatient(w.clinicB, tag)} commit;`);
    check(entry, !wrote.error && !(await waitingOnLock(a.name)) && profiles(tag) === '1', 'a write in clinic B runs while A\'s suspension is in flight');
    await b.send('commit;');
    const after = await a.send(`${begin} ${ten(w, w.clinicB, token(0))} ${readPatient(w.patientB)} commit;`);
    check(entry, last(after) === '1' && !after.error, 'and a fresh token reads in B after A is suspended');
    closeAll(a, b);
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
