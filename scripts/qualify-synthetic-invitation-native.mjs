/**
 * Two-session native qualification of the BLOCKED synthetic-invitation-clinic-status successor on a real PostgreSQL 16
 * server: an invitation issue or claim racing a fictional clinic's suspension, in both orders, on the synthetic-staging
 * schema (infra/aws-clinical-core/migrations), with and without the successor.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-synthetic-invitation-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('synthetic_invitation_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('synthetic_invitation_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('synthetic_invitation_native_arguments_refused');
const SUCCESSOR = 'infra/aws-clinical-core/source-candidates/synthetic-invitation-clinic-status.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`synthetic_invitation_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-synthetic-invitation-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'synthetic-invitation-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional synthetic rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidate is loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'The two sessions call the SQL the synthetic identity API calls; the API, tokens and Data API are not exercised here.',
] };
let started = false;
const sessions = [];
const sha = (text) => createHash('sha256').update(text).digest('hex');
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
  const manifest = JSON.parse(readFileSync(join(root, 'infra/aws-clinical-core/migrations/manifest.json'), 'utf8'));
  if (manifest.migrations.some((m) => /invitation-clinic-status/.test(m.file))) throw Error('synthetic_invitation_native_candidate_already_registered');

  // Fictional rows, the same in both databases: clinic A (the one suspended), clinic B (a sibling), a practitioner of
  // each and a consumer. Patient records are taken per scenario (reset, below).
  const ids = Object.fromEntries(['clinicA', 'clinicB', 'personA', 'personB', 'consumer'].map((key) => [key, randomUUID()]));
  const subject = (id, pool) => `${pool}:syn-${id.replaceAll('-', '')}`;
  const seed = `insert into clinical_core.organizations(id,synthetic_label) values('${ids.clinicA}','FICTIONAL NATIVE A'),('${ids.clinicB}','FICTIONAL NATIVE B');
    insert into clinical_core.persons(id,synthetic_subject_key) values ${[ids.personA, ids.personB, ids.consumer].map((id) => `('${id}','syn_${id.replaceAll('-', '')}')`).join(',')};
    insert into clinical_core.identities(person_id,identity_pool,identity_subject,synthetic_attested) values
      ('${ids.personA}','workforce','${subject(ids.personA, 'workforce')}',true),('${ids.personB}','workforce','${subject(ids.personB, 'workforce')}',true),
      ('${ids.consumer}','consumer','${subject(ids.consumer, 'consumer')}',true);
    insert into clinical_core.organization_memberships(organization_id,person_id,role) values
      ('${ids.clinicA}','${ids.personA}','practitioner'),('${ids.clinicB}','${ids.personB}','practitioner');`;
  for (const [database, candidates] of [['syn_parent', []], ['syn', [SUCCESSOR]]]) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(readFileSync(join(root, 'infra/aws-clinical-core/migrations', migration.file), 'utf8'), database);
    for (const candidate of candidates) psql(readFileSync(join(root, candidate), 'utf8'), database);
    psql(seed, database);
  }

  const open = (name, database) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = psqlSender(child, name, 'synthetic_invitation_native_session_timeout');
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
  const begin = 'begin; set local role clinical_core_api;';
  const workforce = (person, clinic) => `select clinical_private.set_request_context('${person}','${clinic}','workforce','${subject(person, 'workforce')}','identity_link','synthetic-staging','synthetic_only') is null;`;
  const consumerContext = (clinic) => `select clinical_private.set_request_context('${ids.consumer}','${clinic}','consumer','${subject(ids.consumer, 'consumer')}','identity_link','synthetic-staging','synthetic_only') is null;`;
  const expires = () => new Date(Date.now() + 3_600_000).toISOString();
  const issue = (clinic, patient, tokenHash, key = randomUUID()) =>
    `select invitation_id is not null from clinical_core.issue_connection_invitation('${clinic}','${patient}','${tokenHash}','${expires()}'::timestamptz,'${key}');`;
  const claim = (tokenHash) => `select state from clinical_core.claim_connection_invitation('${tokenHash}','${ids.consumer}');`;
  const status = (clinic, value) => `update clinical_core.organizations set status='${value}' where id='${clinic}';`;
  const count = (database, patient) => Number(psql(`select count(*) from clinical_core.connection_invitations where patient_record_id='${patient}'`, database));
  const connectionState = (database, patient) => psql(`select coalesce(string_agg(state, ','), '') from clinical_core.patient_connections where patient_record_id='${patient}'`, database);
  // Invitations and their connections are append-only, so each scenario reactivates both clinics and takes a fresh
  // fictional patient record in each; every count and state below reads that scenario's records only.
  const reset = (database) => {
    const fresh = { A: randomUUID(), B: randomUUID() };
    psql(`update clinical_core.organizations set status='active';
      insert into clinical_core.patient_records(id,organization_id,synthetic_record_key) values
        ('${fresh.A}','${ids.clinicA}','patient_syn_${fresh.A.replaceAll('-', '')}'),('${fresh.B}','${ids.clinicB}','patient_syn_${fresh.B.replaceAll('-', '')}');`, database);
    return fresh;
  };
  const REFUSAL = /\bsynthetic_context_refused\b/;
  // A batch prints one line per statement (the context setter's `t` first); the operation's own result is the last.
  const last = (result) => result.output.split('\n').pop();
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 120);
  let sequence = 0;
  const pair = (database) => { sequence += 1; return [open(`syn_a${sequence}`, database), open(`syn_b${sequence}`, database), `syn_a${sequence}`, `syn_b${sequence}`]; };
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  // The deployed synthetic schema: nothing waits for, or reads, the clinic's status.
  {
    const entry = scenario('parent-issues-and-claims-after-the-clinic-is-suspended');
    const patient = reset('syn_parent');
    const [a, b, aName] = pair('syn_parent');
    const earlier = sha(randomUUID());
    await a.send(`${begin} ${workforce(ids.personA, ids.clinicA)} ${issue(ids.clinicA, patient.A, earlier)} commit;`);
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    await a.send(begin);
    const during = await a.send(`${workforce(ids.personA, ids.clinicA)} ${issue(ids.clinicA, patient.A, sha(randomUUID()))}`);
    check(entry, !during.error, 'with the suspension uncommitted, an issue neither waits nor is refused');
    check(entry, !(await waitingOnLock(aName, 'syn_parent')), 'nothing holds it back');
    await a.send('rollback;');
    await b.send('commit;');
    const claimed = await a.send(`${begin} ${consumerContext(ids.clinicA)} ${claim(earlier)} commit;`);
    check(entry, last(claimed) === 'verified' && !claimed.error, 'after the suspension commits, an earlier invitation is still claimed into a verified connection (the gap)');
    closeAll(a, b);
  }

  // Admitted first: the issue holds the clinic row; the suspension waits for it, and the next issue is refused.
  {
    const entry = scenario('admitted-issue-holds-off-the-suspension');
    const patient = reset('syn');
    const [a, b, , bName] = pair('syn');
    await a.send(`${begin} ${workforce(ids.personA, ids.clinicA)}`);
    const admitted = await a.send(issue(ids.clinicA, patient.A, sha(randomUUID())));
    check(entry, last(admitted) === 't' && !admitted.error, `the issue is admitted into the active clinic${admitted.error ? `: ${firstLine(admitted.error)}` : ''}`);
    const pending = b.send(`begin; ${status(ids.clinicA, 'suspended')} commit;`);
    check(entry, await waitingOnLock(bName, 'syn'), 'the suspension waits on the clinic row the issue holds');
    await a.send('commit;');
    check(entry, !(await pending).error, 'the suspension commits after the issue commits');
    const next = await a.send(`${begin} ${workforce(ids.personA, ids.clinicA)} ${issue(ids.clinicA, patient.A, sha(randomUUID()))}`);
    check(entry, REFUSAL.test(next.error), `the next issue, with the same already-issued identity, is refused (${firstLine(next.error)})`);
    await a.send('rollback;');
    check(entry, count('syn', patient.A) === 1, 'exactly one invitation exists');
    closeAll(a, b);
  }

  // Suspension first, uncommitted: the issue waits on the clinic row, then re-reads the committed status and is refused.
  {
    const entry = scenario('issue-waiting-on-a-pending-suspension-is-refused');
    const patient = reset('syn');
    const [a, b, aName] = pair('syn');
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    await a.send(`${begin} ${workforce(ids.personA, ids.clinicA)}`);
    const pending = a.send(issue(ids.clinicA, patient.A, sha(randomUUID())));
    check(entry, await waitingOnLock(aName, 'syn'), 'the issue waits on the uncommitted suspension');
    await b.send('commit;');
    const refused = await pending;
    check(entry, REFUSAL.test(refused.error), `after the suspension commits, the issue is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    check(entry, count('syn', patient.A) === 0, 'no invitation was written');
    closeAll(a, b);
  }

  // An invitation issued before the suspension, claimed while it is pending: the claim waits, then is refused.
  {
    const entry = scenario('claim-waiting-on-a-pending-suspension-is-refused');
    const patient = reset('syn');
    const [a, b, aName] = pair('syn');
    const token = sha(randomUUID());
    const issued = await a.send(`${begin} ${workforce(ids.personA, ids.clinicA)} ${issue(ids.clinicA, patient.A, token)} commit;`);
    check(entry, last(issued) === 't' && !issued.error, 'the invitation is issued while the clinic is active');
    await b.send(`begin; ${status(ids.clinicA, 'archived')}`);
    await a.send(`${begin} ${consumerContext(ids.clinicA)}`);
    const pending = a.send(claim(token));
    check(entry, await waitingOnLock(aName, 'syn'), 'the claim waits on the uncommitted archival');
    await b.send('commit;');
    const refused = await pending;
    check(entry, REFUSAL.test(refused.error), `after the archival commits, the claim is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    check(entry, connectionState('syn', patient.A) === 'invitation_pending', 'the connection stays unverified');
    closeAll(a, b);
  }

  // A pending suspension of clinic A does not hold back clinic B.
  {
    const entry = scenario('a-sibling-clinic-is-not-held-back');
    const patient = reset('syn');
    const [a, b, aName] = pair('syn');
    await b.send(`begin; ${status(ids.clinicA, 'suspended')}`);
    const token = sha(randomUUID());
    const issued = await a.send(`${begin} ${workforce(ids.personB, ids.clinicB)} ${issue(ids.clinicB, patient.B, token)}`);
    check(entry, last(issued) === 't' && !issued.error && !(await waitingOnLock(aName, 'syn')), 'clinic B issues without waiting');
    await a.send('commit;');
    const claimed = await a.send(`${begin} ${consumerContext(ids.clinicB)} ${claim(token)} commit;`);
    check(entry, last(claimed) === 'verified' && !claimed.error, 'and its invitation is claimed');
    await b.send('rollback;');
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
