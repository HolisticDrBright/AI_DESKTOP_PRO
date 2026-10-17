/**
 * Two-session native qualification of the BLOCKED workforce-consent-decision-clinic-status successor on a real
 * PostgreSQL 16 server: a practitioner's consent decision racing a fictional clinic's suspension, in both orders, on the
 * production schema (scripts/build-aws-production-clinical-core.mjs). Both databases carry the BLOCKED
 * legacy-claims-clinic-status successor. Only `alp` also carries the consent-decision successor, so `alp_parent` shows
 * the residual that the second successor closes.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-consent-decision-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('consent_decision_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('consent_decision_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('consent_decision_native_arguments_refused');
const STATUS = 'infra/aws-clinical-core/source-candidates/legacy-claims-clinic-status.sql';
const DECISION = 'infra/aws-clinical-core/source-candidates/workforce-consent-decision-clinic-status.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`consent_decision_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-consent-decision-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'consent-decision-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidates are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'The two sessions call the SQL the identity service calls (set_request_context, then the decision function); the service, tokens and Data API are not exercised here.',
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
  if (manifest.migrations.some((m) => /clinic-status|consent-decision/.test(m.file))) throw Error('consent_decision_native_candidate_already_registered');

  // Fictional rows, the same in both databases: clinic A (the one suspended), clinic B (a sibling), a practitioner of
  // each, a retention service identity and its release. Patients are taken fresh per scenario (below).
  const ids = Object.fromEntries(['clinicA', 'clinicB', 'personA', 'personB', 'service', 'reviewer'].map((key) => [key, randomUUID()]));
  const sub = (id) => `subject-${id}`;
  const seed = `insert into clinical_core.organizations(id,organization_label) values('${ids.clinicA}','FICTIONAL NATIVE A'),('${ids.clinicB}','FICTIONAL NATIVE B');
    insert into clinical_core.persons(id,subject_key) values ${[ids.personA, ids.personB, ids.service, ids.reviewer].map((id) => `('${id}','subject_${id.replaceAll('-', '')}')`).join(',')};
    insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values
      ${[ids.personA, ids.personB, ids.service, ids.reviewer].map((id) => `('${id}','workforce','${sub(id)}',true)`).join(',')};
    insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ('${ids.clinicA}','${ids.personA}','practitioner'),('${ids.clinicB}','${ids.personB}','practitioner');
    insert into clinical_private.privacy_retention_service_releases(version,service_person_id,identity_subject,evidence_sha256,approved_by,approved_at)
      values('fictional-native','${ids.service}','${sub(ids.service)}',repeat('a',64),'${ids.reviewer}',clock_timestamp()-interval '1 hour');`;
  for (const [database, candidates] of [['alp_parent', [STATUS]], ['alp', [STATUS, DECISION]]]) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(files[migration.file], database);
    for (const candidate of candidates) psql(readFileSync(join(root, candidate), 'utf8'), database);
    psql(seed, database);
  }

  const open = (name, database) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = psqlSender(child, name, 'consent_decision_native_session_timeout');
    const session = { send, child };
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
  /** A fresh fictional patient in the clinic, with a verified app connection and an approved consent artifact. */
  const fresh = (database, clinic) => {
    const row = { consumer: randomUUID(), patient: randomUUID(), connection: randomUUID(), artifact: randomUUID() };
    psql(`insert into clinical_core.persons(id,subject_key) values('${row.consumer}','subject_${row.consumer.replaceAll('-', '')}');
      insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${row.consumer}','consumer','${sub(row.consumer)}',true);
      insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values('${row.patient}','${clinic}','patient_${row.patient.replaceAll('-', '')}','Fictional','Native');
      insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values('${row.connection}','${clinic}','${row.patient}','${row.consumer}','verified',clock_timestamp());
      insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
        values('${row.artifact}','${clinic}','forms_checkins','fictional-${row.artifact.slice(0, 8)}',repeat('c',64),'US-FICTIONAL','approved',clock_timestamp(),'${ids.reviewer}');`, database);
    return row;
  };
  const begin = 'begin; set local role clinical_core_api;';
  const context = (person, clinic, pool = 'workforce') =>
    `select clinical_private.set_request_context('${person}','${clinic}','${pool}','${sub(person)}','consent_management','production-clinical','clinical_phi') is null;`;
  const grant = (row) => `select status from clinical_core.record_consent_grant('${row.connection}','${row.artifact}','forms_checkins','in_person','self');`;
  const revoke = (row) => `select status from clinical_core.revoke_consent_grant('${row.connection}','forms_checkins','patient_request');`;
  const sweep = `select jsonb_typeof(clinical_private.list_privacy_export_cleanup_for_retention(25));`;
  const status = (clinic, value) => `update clinical_core.organizations set status='${value}' where id='${clinic}';`;
  const history = (database, row) => psql(`select coalesce(string_agg(version || ':' || status, ',' order by version), '') from clinical_core.consent_grants where connection_id='${row.connection}'`, database);
  const REFUSAL = /\bconsent_actor_refused\b/;
  // A batch prints one line per statement (the context setter's `t` first); the operation's own result is the last.
  const last = (result) => result.output.split('\n').pop();
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 120);
  let sequence = 0;
  const pair = (database) => { sequence += 1; return [open(`alp_cd_a${sequence}`, database), open(`alp_cd_b${sequence}`, database), `alp_cd_a${sequence}`, `alp_cd_b${sequence}`]; };
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };
  const reactivate = (database) => psql(`update clinical_core.organizations set status='active';`, database);

  // The status successor alone: workforce consent management is admitted, so a practitioner decision neither waits for
  // a pending suspension nor is refused after it.
  {
    const entry = scenario('status-successor-alone-admits-a-practitioner-decision-in-a-suspended-clinic');
    reactivate('alp_parent');
    const row = fresh('alp_parent', ids.clinicA);
    const [a, b, aName] = pair('alp_parent');
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    await a.send(begin);
    const during = await a.send(`${context(ids.personA, ids.clinicA)} ${grant(row)}`);
    check(entry, last(during) === 'granted' && !during.error, 'with the suspension uncommitted, the grant neither waits nor is refused');
    check(entry, !(await waitingOnLock(aName, 'alp_parent')), 'nothing holds it back');
    await a.send('commit;');
    await b.send('commit;');
    const after = await a.send(`${begin} ${context(ids.personA, ids.clinicA)} ${revoke(row)} commit;`);
    check(entry, last(after) === 'revoked' && !after.error, 'after the suspension commits, the same practitioner still records a withdrawal (the residual)');
    check(entry, history('alp_parent', row) === '1:granted,2:revoked', 'both decisions landed in the suspended clinic');
    closeAll(a, b);
  }

  // Admitted first: a new grant holds the clinic row; the suspension waits. Afterwards a withdrawal still narrows
  // processing, while a new grant remains refused by the active-clinic check.
  {
    const entry = scenario('admitted-decision-holds-off-the-suspension');
    reactivate('alp');
    const row = fresh('alp', ids.clinicA);
    const [a, b, , bName] = pair('alp');
    await a.send(`${begin} ${context(ids.personA, ids.clinicA)}`);
    const admitted = await a.send(grant(row));
    check(entry, admitted.output === 'granted' && !admitted.error, `the grant is admitted into the active clinic${admitted.error ? `: ${firstLine(admitted.error)}` : ''}`);
    const pending = b.send(`begin; ${status(ids.clinicA, 'suspended')} commit;`);
    check(entry, await waitingOnLock(bName, 'alp'), 'the suspension waits on the clinic row the decision holds');
    await a.send('commit;');
    check(entry, !(await pending).error, 'the suspension commits after the decision commits');
    const next = await a.send(`${begin} ${context(ids.personA, ids.clinicA)} ${revoke(row)} commit;`);
    check(entry, last(next) === 'revoked' && !next.error, 'the same authorized practitioner may record a withdrawal after suspension');
    check(entry, history('alp', row) === '1:granted,2:revoked', 'the admitted grant and later withdrawal are recorded');
    const newGrant = await a.send(`${begin} ${context(ids.personA, ids.clinicA)} ${grant(row)}`);
    check(entry, REFUSAL.test(newGrant.error), `a new grant in the closed clinic is refused (${firstLine(newGrant.error)})`);
    await a.send('rollback;');
    closeAll(a, b);
  }

  // Suspension first, uncommitted: the decision waits on the clinic row, then re-reads the committed status and is refused.
  {
    const entry = scenario('decision-waiting-on-a-pending-suspension-is-refused');
    reactivate('alp');
    const row = fresh('alp', ids.clinicA);
    const [a, b, aName] = pair('alp');
    await b.send(`begin; ${status(ids.clinicA, 'archived')}`);
    await a.send(`${begin} ${context(ids.personA, ids.clinicA)}`);
    const pending = a.send(grant(row));
    check(entry, await waitingOnLock(aName, 'alp'), 'the grant waits on the uncommitted archival');
    await b.send('commit;');
    const refused = await pending;
    check(entry, REFUSAL.test(refused.error), `after the archival commits, the grant is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    check(entry, history('alp', row) === '', 'no decision was written');
    const retry = await a.send(`${begin} ${context(ids.personA, ids.clinicA)} ${grant(row)}`);
    check(entry, REFUSAL.test(retry.error), 'a retry of the same grant afterwards is refused too');
    await a.send('rollback;');
    closeAll(a, b);
  }

  // The patient's own withdrawal and the retention service are not held back by a pending suspension.
  {
    const entry = scenario('patient-withdrawal-and-retention-sweep-are-not-held-back');
    reactivate('alp');
    const row = fresh('alp', ids.clinicA);
    psql(`begin; set local role clinical_core_api; ${context(ids.personA, ids.clinicA)} ${grant(row)} commit;`, 'alp');
    const [a, b, aName] = pair('alp');
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    const withdrawn = await a.send(`${begin} ${context(row.consumer, ids.clinicA, 'consumer')} ${revoke(row)} commit;`);
    check(entry, last(withdrawn) === 'revoked' && !withdrawn.error, `the patient's own withdrawal commits during the pending suspension${withdrawn.error ? `: ${firstLine(withdrawn.error)}` : ''}`);
    const swept = await a.send(`${begin} ${context(ids.service, ids.clinicA)} ${sweep} commit;`);
    check(entry, last(swept) === 'array' && !swept.error && !(await waitingOnLock(aName, 'alp')), 'the retention sweep runs without waiting');
    await b.send('commit;');
    const sweptAfter = await a.send(`${begin} ${context(ids.service, ids.clinicA)} ${sweep} commit;`);
    check(entry, last(sweptAfter) === 'array' && !sweptAfter.error, 'and runs after the suspension commits');
    check(entry, history('alp', row) === '1:granted,2:revoked', 'the withdrawal is recorded');
    closeAll(a, b);
  }

  // A pending suspension of clinic A does not hold back clinic B's practitioner.
  {
    const entry = scenario('a-sibling-clinic-is-not-held-back');
    reactivate('alp');
    const row = fresh('alp', ids.clinicB);
    const [a, b, aName] = pair('alp');
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    const decided = await a.send(`${begin} ${context(ids.personB, ids.clinicB)} ${grant(row)}`);
    check(entry, last(decided) === 'granted' && !decided.error && !(await waitingOnLock(aName, 'alp')), 'clinic B records its decision without waiting');
    await a.send('commit;');
    await b.send('rollback;');
    check(entry, history('alp', row) === '1:granted', 'and it is recorded');
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
