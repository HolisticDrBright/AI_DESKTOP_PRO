/**
 * Two-session native qualification of the BLOCKED workforce-consent-grant-paths-clinic-status successor on a real
 * PostgreSQL 16 server: an ordinary clinic suspension racing a practitioner's new consent grant and withdrawal on the
 * sync screen (set_sync_consent_scope) and a new recording consent, in both orders, on the production schema
 * (scripts/build-aws-production-clinical-core.mjs) with the consent-decision candidate as parent.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-consent-grant-paths-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('consent_grant_paths_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('consent_grant_paths_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('consent_grant_paths_native_arguments_refused');
const DECISION = 'infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql';
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-consent-grant-paths-clinic-status.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`consent_grant_paths_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-consent-grant-paths-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'consent-grant-paths-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidate and its parents are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'The sessions call the SQL the services call (set_request_context, then the operation); tokens, Cognito and the Data API are not exercised here.',
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
  if (manifest.migrations.some((m) => /suspension-window/.test(m.file))) throw Error('consent_grant_paths_native_candidate_already_registered');

  // `alp` carries the candidate on its parent; `alp_parent` stops at the consent-decision candidate, to show the gap.
  for (const database of ['alp', 'alp_parent']) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(files[migration.file], database);
    for (const file of database === 'alp' ? [DECISION, CANDIDATE] : [DECISION]) psql(readFileSync(join(root, file), 'utf8'), database);
  }
  report.entries = Object.fromEntries(['alp', 'alp_parent'].map((database) => [database,
    psql(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('clinical_core.set_sync_consent_scope(uuid,text,boolean,text,text,text,text,text)')`, database)]));

  /** A fresh fictional clinic with a practitioner, a patient, a verified connection, an approved sync artifact, an
   * in-progress encounter with a recording participant, and an approved recording consent release. */
  const world = (database = 'alp') => {
    const w = { clinic: randomUUID(), person: randomUUID(), subject: randomUUID(), consumer: randomUUID(), patient: randomUUID(), connection: randomUUID(),
      artifact: randomUUID(), release: randomUUID(), version: `fictional-${randomUUID().slice(0, 8)}` };
    psql(`insert into clinical_core.organizations(id,organization_label) values('${w.clinic}','FICTIONAL NATIVE');
      insert into clinical_core.persons(id,subject_key) values('${w.person}','subject_${w.person.replaceAll('-', '')}'),('${w.consumer}','subject_${w.consumer.replaceAll('-', '')}');
      insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${w.person}','workforce','${w.subject}',true),('${w.consumer}','consumer','consumer-${w.consumer}',true);
      insert into clinical_core.organization_memberships(organization_id,person_id,role) values('${w.clinic}','${w.person}','practitioner');
      insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values('${w.patient}','${w.clinic}','patient_${w.patient.replaceAll('-', '')}','Fictional','Native');
      insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values('${w.connection}','${w.clinic}','${w.patient}','${w.consumer}','verified',clock_timestamp());
      insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_title,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
        values('${w.artifact}','${w.clinic}','forms_checkins','FICTIONAL sync consent','${w.version}',repeat('c',64),'US-FICTIONAL','approved',clock_timestamp(),'${w.person}');
      insert into clinical_private.recording_consent_releases(id,organization_id,scope,version,locale,jurisdiction,content,content_sha256,approved_by,approved_at)
        values('${w.release}','${w.clinic}','ai_drafting','${w.release}','en','FICTIONAL','FICTIONAL CONSENT ONLY',encode(public.digest('FICTIONAL CONSENT ONLY','sha256'),'hex'),'FICTIONAL TEST REVIEW',clock_timestamp()-interval '1 day');`, database);
    const as = `begin; set local role clinical_core_api; select clinical_private.set_request_context('${w.person}','${w.clinic}','workforce','${w.subject}','clinical_data','production-clinical','clinical_phi') is null;`;
    w.encounter = psql(`${as} select clinical_core.start_encounter('${w.clinic}','${w.patient}'); commit;`, database).split('\n').pop();
    w.participant = psql(`${as} select clinical_private.add_encounter_recording_participant('${w.encounter}','patient','FICTIONAL PARTICIPANT',true,'${randomUUID()}'); commit;`, database).split('\n').pop();
    return w;
  };
  const open = (name, database = 'alp') => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { send: psqlSender(child, name, 'consent_grant_paths_native_session_timeout'), child, name };
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
  const sessionsFor = (count, database = 'alp') => Array.from({ length: count }, () => { sequence += 1; return open(`alp_cg_${sequence}`, database); });
  const begin = (w) => `begin; set local role clinical_core_api; select clinical_private.set_request_context('${w.person}','${w.clinic}','workforce','${w.subject}','clinical_data','production-clinical','clinical_phi') is null;`;
  const sync = (w, grant) => `select clinical_core.set_sync_consent_scope('${w.connection}','forms_checkins',${grant},'FICTIONAL sync consent','${w.version}','US-FICTIONAL','in_person','self')->>'status';`;
  const recording = (w, command = randomUUID()) => `select clinical_private.grant_encounter_recording_consent('${w.participant}','${w.release}','${command}','written','FICTIONAL ACK',null) is not null;`;
  const suspend = (w) => `begin; update clinical_core.organizations set status='suspended' where id='${w.clinic}';`;
  const latest = (w, database = 'alp') => psql(`select coalesce((select status from clinical_core.consent_grants where connection_id='${w.connection}' order by version desc limit 1),'none')`, database);
  const recordings = (w, database = 'alp') => psql(`select count(*) from clinical_private.recording_consent_grants where participant_id='${w.participant}'`, database);
  const REFUSED = /\bconsent_actor_refused\b/;
  const last = (result) => result.output.split('\n').pop();
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 140);
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  // Failing-before, on the consent-decision candidate alone: after a suspension the sync screen and the recording consent
  // both record a new grant.
  {
    const entry = scenario('on-the-parent-new-grants-are-recorded-in-a-suspended-clinic');
    const w = world('alp_parent');
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinic}'`, 'alp_parent');
    const [a] = sessionsFor(1, 'alp_parent');
    const granted = await a.send(`${begin(w)} ${sync(w, true)} commit;`);
    check(entry, last(granted) === 'granted' && !granted.error && latest(w, 'alp_parent') === 'granted', 'DEFECT on the parent: the sync screen records a new grant in the suspended clinic');
    const recorded = await a.send(`${begin(w)} ${recording(w)} commit;`);
    check(entry, !recorded.error && recordings(w, 'alp_parent') === '1', 'DEFECT on the parent: a new recording consent is recorded in the suspended clinic');
    closeAll(a);
  }

  // A grant admitted first holds the clinic row at its mutation; the suspension waits for it.
  {
    const entry = scenario('an-admitted-grant-holds-off-the-suspension');
    const w = world();
    const [a, b] = sessionsFor(2);
    const granted = await a.send(`${begin(w)} ${sync(w, true)}`);
    check(entry, last(granted) === 'granted' && !granted.error, 'the grant is made in the active clinic and still open');
    const pending = b.send(`${suspend(w)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the suspension waits on the clinic row the grant holds');
    await a.send('commit;');
    check(entry, !(await pending).error && latest(w) === 'granted', 'the grant committed before the suspension did');
    closeAll(a, b);
  }

  // A suspension in flight: a new grant waits for it at the mutation, then re-reads and is refused; nothing is written.
  {
    const entry = scenario('a-grant-waiting-on-a-suspension-in-flight-is-refused');
    const w = world();
    const [a, b, c] = sessionsFor(3);
    await b.send(suspend(w));
    await a.send(begin(w));
    const waiting = a.send(sync(w, true));
    await c.send(begin(w));
    const waitingRecording = c.send(recording(w));
    check(entry, await waitingOnLock(a.name) && await waitingOnLock(c.name), 'both new grants wait on the suspension');
    await b.send('commit;');
    const refused = await waiting, refusedRecording = await waitingRecording;
    check(entry, REFUSED.test(refused.error), `the sync-screen grant is refused (${firstLine(refused.error)})`);
    check(entry, REFUSED.test(refusedRecording.error), `the recording consent is refused (${firstLine(refusedRecording.error)})`);
    await a.send('rollback;');
    await c.send('rollback;');
    check(entry, latest(w) === 'none' && recordings(w) === '0', 'nothing was written');
    closeAll(a, b, c);
  }

  // Withdrawal in both orders: it never waits on the clinic row, and it lands whether the suspension commits first or not.
  {
    const entry = scenario('a-withdrawal-lands-in-both-orders');
    const w = world();
    psql(`${begin(w)} ${sync(w, true)} commit;`);
    const [a, b] = sessionsFor(2);
    await b.send(suspend(w));
    const withdrawn = await a.send(`${begin(w)} ${sync(w, false)} commit;`);
    check(entry, last(withdrawn) === 'revoked' && !withdrawn.error && !(await waitingOnLock(a.name)), 'during the suspension in flight the withdrawal lands without waiting');
    await b.send('commit;');
    psql(`update clinical_core.organizations set status='active' where id='${w.clinic}'`);
    psql(`${begin(w)} ${sync(w, true)} commit;`);
    psql(`update clinical_core.organizations set status='suspended' where id='${w.clinic}'`);
    const after = await a.send(`${begin(w)} ${sync(w, false)} commit;`);
    check(entry, last(after) === 'revoked' && !after.error && latest(w) === 'revoked', 'after the suspension committed, a withdrawal of a later grant lands');
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
