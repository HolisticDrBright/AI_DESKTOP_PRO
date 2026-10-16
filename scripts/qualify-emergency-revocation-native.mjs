/**
 * Two-session native qualification of the BLOCKED workforce-identity-emergency-revocation successor on a real
 * PostgreSQL 16 server: a platform operator's emergency revocation of one practitioner's login racing that login's own
 * reads and writes, in both orders, on the production schema (scripts/build-aws-production-clinical-core.mjs) with the
 * platform-operator chain the candidate names as its parents.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-emergency-revocation-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('emergency_revocation_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('emergency_revocation_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('emergency_revocation_native_arguments_refused');
const CHAIN = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const CANDIDATE = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation.sql';
const ROLLBACK = 'infra/aws-clinical-core/source-candidates/workforce-identity-emergency-revocation-rollback.sql';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`emergency_revocation_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-emergency-revocation-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'emergency-revocation-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidate and its parents are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'The sessions call the SQL the services call (set_request_context or set_current_workforce_context, then the operation; the operator functions on the operator role). Tokens, Cognito, the fence store and the Data API are not exercised here.',
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
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c timezone=UTC -c max_connections=16`, '-w', '-t', '30', 'start']);
  started = true;
  const psql = (sql, database = 'alp') => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (manifest.migrations.some((m) => /revocation/.test(m.file))) throw Error('emergency_revocation_native_candidate_already_registered');

  // `alp` carries the candidate. `alp_unlocked` carries the same tables and operator functions with the parent's entry
  // put back (no share-lock), to show what the lock is for.
  const rollback = readFileSync(join(root, ROLLBACK), 'utf8');
  const parentEntry = rollback.slice(rollback.indexOf('create or replace function clinical_private.set_request_context'), rollback.indexOf('$$;') + 3);
  const ids = Object.fromEntries(['clinicA', 'clinicB', 'patientA', 'patientB', 'op1', 'op2'].map((key) => [key, randomUUID()]));
  for (const database of ['alp', 'alp_unlocked']) {
    psql(`create database ${database}`, 'postgres');
    psql('create extension if not exists pgcrypto', database);
    for (const migration of manifest.migrations) psql(files[migration.file], database);
    for (const file of [...CHAIN, CANDIDATE]) psql(readFileSync(join(root, file), 'utf8'), database);
    if (database === 'alp_unlocked') psql(parentEntry, database);
    // Fictional rows: clinic A and its sibling B, a patient in each, two registered platform operators.
    psql(`insert into clinical_core.organizations(id,organization_label) values('${ids.clinicA}','FICTIONAL NATIVE A'),('${ids.clinicB}','FICTIONAL NATIVE B');
      insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values
        ('${ids.patientA}','${ids.clinicA}','patient_${ids.patientA.replaceAll('-', '')}','Fictional','Native'),
        ('${ids.patientB}','${ids.clinicB}','patient_${ids.patientB.replaceAll('-', '')}','Fictional','Native');
      insert into clinical_private.workforce_platform_operators(operator_subject,status) values('${ids.op1}','active'),('${ids.op2}','active');`, database);
  }
  report.entries = { alp: psql(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')`),
    alp_unlocked: psql(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('clinical_private.set_request_context(uuid,uuid,text,text,text,text,text)')`, 'alp_unlocked') };
  const mode = (value, database = 'alp') => psql(`update clinical_private.workforce_identity_revocation_release set enabled=true, approval_mode='${value}' where singleton;`, database);
  /** A fresh fictional practitioner (each revocation is permanent), a member of the named clinics. */
  const practitioner = (clinics, database = 'alp') => {
    const who = { person: randomUUID(), subject: randomUUID() };
    psql(`insert into clinical_core.persons(id,subject_key) values('${who.person}','subject_${who.person.replaceAll('-', '')}');
      insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${who.person}','workforce','${who.subject}',true);
      insert into clinical_core.organization_memberships(organization_id,person_id,role) values ${clinics.map((clinic) => `('${clinic}','${who.person}','practitioner')`).join(',')};`, database);
    return who;
  };

  const open = (name, database = 'alp') => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    const send = psqlSender(child, name, 'emergency_revocation_native_session_timeout');
    const session = { send, child, name };
    sessions.push(session);
    return session;
  };
  const waitingOnLock = async (name, database = 'alp') => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = psql(`select coalesce(wait_event_type,'') from pg_stat_activity where application_name='${name}' and state='active'`, database);
      if (state === 'Lock') return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  let sequence = 0;
  const sessionsFor = (count, database = 'alp') => Array.from({ length: count }, () => { sequence += 1; return open(`alp_er_${sequence}`, database); });
  const begin = 'begin; set local role clinical_core_api;';
  const context = (who, clinic, purpose = 'clinical_data') =>
    `select clinical_private.set_request_context('${who.person}','${clinic}','workforce','${who.subject}','${purpose}','production-clinical','clinical_phi') is null;`;
  const current = (who, clinic) => `select (clinical_private.set_current_workforce_context('${who.subject}','${clinic}','clinical_data')->>'role');`;
  const readPatient = (patient) => `select count(*) from clinical_core.patient_records where id='${patient}';`;
  const writePatient = (clinic, last) => `select clinical_core.create_patient_profile('${clinic}','Fictional','${last}') is not null;`;
  const operator = 'begin; set local role clinical_workforce_operator;';
  const propose = (op, who, request = randomUUID()) =>
    `select (r->>'state')||','||(r->>'duplicate')||','||(r->>'proposalId') from (select clinical_private.propose_workforce_identity_revocation('${op}','${request}','${who.subject}','suspected_compromise') r) x;`;
  const approve = (op, proposal) =>
    `select (r->>'state')||','||(r->>'duplicate') from (select clinical_private.decide_workforce_identity_revocation('${op}','${proposal}','approve') r) x;`;
  const identity = (who, database = 'alp') => psql(`select status from clinical_core.identities where identity_subject='${who.subject}'`, database);
  const profiles = (last, database = 'alp') => psql(`select count(*) from clinical_core.patient_records where last_name='${last}'`, database);
  const REFUSED = /\brequest_context_refused\b/;
  const CURRENT_REFUSED = /\bworkforce_membership_refused\b/;
  // A batch prints one line per statement; the operation's own result is the last line.
  const last = (result) => result.output.split('\n').pop();
  const firstLine = (text) => text.split('\n')[0].replace(/^psql:[^E]*/, '').slice(0, 120);
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  mode('independent_review_after');
  mode('independent_review_after', 'alp_unlocked');

  // Failing-before: the same writer with the parent's entry. The revocation does not wait for the admitted write, so its
  // receipt is returned while the compromised session's write is still open, and that write commits after the receipt.
  {
    const entry = scenario('without-the-entry-lock-a-receipt-precedes-an-admitted-write');
    const who = practitioner([ids.clinicA], 'alp_unlocked');
    const tag = `Native${randomUUID().slice(0, 8)}`;
    const [a, b] = sessionsFor(2, 'alp_unlocked');
    await a.send(`${begin} ${context(who, ids.clinicA)}`);
    const wrote = await a.send(writePatient(ids.clinicA, tag));
    check(entry, wrote.output === 't' && !wrote.error, 'the compromised session\'s write is admitted and still open');
    const receipt = await b.send(`${operator} ${propose(ids.op1, who)} commit;`);
    check(entry, last(receipt).startsWith('revoked,false') && !receipt.error && !(await waitingOnLock(b.name, 'alp_unlocked')),
      'DEFECT without the lock: the revocation receipt returns at once, without waiting for the open write');
    check(entry, identity(who, 'alp_unlocked') === 'disabled' && profiles(tag, 'alp_unlocked') === '0', 'at the receipt the login is disabled and the write is not yet visible');
    const committed = await a.send('commit;');
    check(entry, !committed.error && profiles(tag, 'alp_unlocked') === '1', 'DEFECT without the lock: the write then commits after the receipt');
    closeAll(a, b);
  }

  // Admitted first: the login's read holds its identity row; the revocation waits for it, and the next request is refused.
  {
    const entry = scenario('admitted-read-holds-off-the-revocation');
    const who = practitioner([ids.clinicA]);
    const [a, b] = sessionsFor(2);
    await a.send(`${begin} ${context(who, ids.clinicA)}`);
    const admitted = await a.send(readPatient(ids.patientA));
    check(entry, admitted.output === '1' && !admitted.error, 'the already-issued session reads the patient in the active clinic');
    const pending = b.send(`${operator} ${propose(ids.op1, who)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the revocation waits on the identity row the admitted request holds');
    const stillAdmitted = await a.send(readPatient(ids.patientA));
    check(entry, stillAdmitted.output === '1' && !stillAdmitted.error, 'the admitted request finishes its own work');
    await a.send('commit;');
    const revoked = await pending;
    check(entry, last(revoked).startsWith('revoked,false') && !revoked.error, `the revocation commits after the request commits${revoked.error ? `: ${firstLine(revoked.error)}` : ''}`);
    const next = await a.send(`${begin} ${context(who, ids.clinicA)} ${readPatient(ids.patientA)}`);
    check(entry, REFUSED.test(next.error), `the next request with the same token is refused (${firstLine(next.error)})`);
    await a.send('rollback;');
    closeAll(a, b);
  }

  // Revocation first, uncommitted: the request waits on the identity row, then re-reads the committed row and is refused.
  {
    const entry = scenario('request-waiting-on-a-pending-revocation-is-refused');
    const who = practitioner([ids.clinicA]);
    const [a, b] = sessionsFor(2);
    const proposed = await b.send(`${operator} ${propose(ids.op1, who)}`);
    check(entry, last(proposed).startsWith('revoked,false') && !proposed.error, 'the revocation is recorded and not yet committed');
    await a.send(begin);
    const pending = a.send(`${context(who, ids.clinicA)} ${readPatient(ids.patientA)}`);
    check(entry, await waitingOnLock(a.name), 'the request waits on the uncommitted revocation');
    await b.send('commit;');
    const refused = await pending;
    check(entry, REFUSED.test(refused.error), `after the revocation commits, the waiting request is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    check(entry, identity(who) === 'disabled', 'the identity is disabled');
    closeAll(a, b);
  }

  // A write in both orders: admitted before, it lands before the revocation's receipt; waiting on it, nothing is written.
  {
    const entry = scenario('write-racing-the-revocation-in-both-orders');
    const first = practitioner([ids.clinicA]), second = practitioner([ids.clinicA]);
    const tagFirst = `Native${randomUUID().slice(0, 8)}`, tagSecond = `Native${randomUUID().slice(0, 8)}`;
    const [a, b] = sessionsFor(2);
    await a.send(`${begin} ${context(first, ids.clinicA)}`);
    const wrote = await a.send(writePatient(ids.clinicA, tagFirst));
    check(entry, wrote.output === 't' && !wrote.error, 'the admitted write is made');
    const pending = b.send(`${operator} ${propose(ids.op1, first)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the revocation waits for the admitted write');
    await a.send('commit;');
    check(entry, !(await pending).error, 'the revocation commits after the write commits');
    check(entry, profiles(tagFirst) === '1', 'the admitted write is there, committed before the receipt');
    await b.send(`${operator} ${propose(ids.op1, second)}`);
    await a.send(begin);
    const waiting = a.send(`${context(second, ids.clinicA)} ${writePatient(ids.clinicA, tagSecond)}`);
    check(entry, await waitingOnLock(a.name), 'a write that arrives during the pending revocation waits');
    await b.send('commit;');
    const refused = await waiting;
    check(entry, REFUSED.test(refused.error), `then it is refused (${firstLine(refused.error)})`);
    await a.send('rollback;');
    check(entry, profiles(tagSecond) === '0', 'and nothing was written');
    closeAll(a, b);
  }

  // The current-membership setter and the sibling clinic: the same row, the same answer.
  {
    const entry = scenario('current-authority-and-another-clinic-are-refused-too');
    const who = practitioner([ids.clinicA, ids.clinicB]);
    const [a, b, c] = sessionsFor(3);
    await b.send(`${operator} ${propose(ids.op1, who)}`);
    await a.send(begin);
    const viaSetter = a.send(current(who, ids.clinicA));
    await c.send(begin);
    const viaSibling = c.send(`${context(who, ids.clinicB)} ${readPatient(ids.patientB)}`);
    check(entry, await waitingOnLock(a.name) && await waitingOnLock(c.name), 'both wait on the pending revocation');
    await b.send('commit;');
    const setterRefused = await viaSetter, siblingRefused = await viaSibling;
    check(entry, CURRENT_REFUSED.test(setterRefused.error), `the current-membership setter refuses (${firstLine(setterRefused.error)})`);
    check(entry, REFUSED.test(siblingRefused.error), `the sibling clinic refuses (${firstLine(siblingRefused.error)})`);
    await a.send('rollback;');
    await c.send('rollback;');
    closeAll(a, b, c);
  }

  // An unrelated practitioner is never held back by someone else's pending revocation.
  {
    const entry = scenario('an-unrelated-practitioner-is-not-held-back');
    const who = practitioner([ids.clinicA]), colleague = practitioner([ids.clinicA]);
    const [a, b] = sessionsFor(2);
    await b.send(`${operator} ${propose(ids.op1, who)}`);
    const read = await a.send(`${begin} ${context(colleague, ids.clinicA)} ${readPatient(ids.patientA)} commit;`);
    check(entry, last(read) === '1' && !read.error && !(await waitingOnLock(a.name)), 'the colleague reads without waiting');
    await b.send('commit;');
    const after = await a.send(`${begin} ${context(colleague, ids.clinicA)} ${readPatient(ids.patientA)} commit;`);
    check(entry, last(after) === '1' && !after.error, 'and after the revocation commits');
    closeAll(a, b);
  }

  // A retried revocation (a lost answer, a double click) waits for the first and converges on it.
  {
    const entry = scenario('a-retried-revocation-converges-on-the-request-id');
    const who = practitioner([ids.clinicA]);
    const request = randomUUID();
    const [a, b] = sessionsFor(2);
    const first = await a.send(`${operator} ${propose(ids.op1, who, request)}`);
    const retry = b.send(`${operator} ${propose(ids.op1, who, request)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the retry waits for the first');
    await a.send('commit;');
    const answered = await retry;
    const [state, , proposal] = last(first).split(',');
    check(entry, state === 'revoked' && last(answered) === `revoked,true,${proposal}` && !answered.error, 'the retry answers the same proposal as a duplicate');
    check(entry, psql(`select count(*) from clinical_private.workforce_identity_revocation_proposals where request_id='${request}'`) === '1', 'one proposal exists');
    closeAll(a, b);
  }

  // Second operator before: the approval is what disables the login, so the approval waits for an admitted request.
  {
    const entry = scenario('an-approval-waits-for-an-admitted-request');
    mode('second_operator_before');
    const who = practitioner([ids.clinicA]);
    const [a, b] = sessionsFor(2);
    const proposed = psql(`${operator} ${propose(ids.op1, who)} commit;`).split('\n').pop();
    const [state, , proposal] = proposed.split(',');
    check(entry, state === 'awaiting_approval', 'the proposal alone changes nothing');
    await a.send(`${begin} ${context(who, ids.clinicA)}`);
    const admitted = await a.send(readPatient(ids.patientA));
    check(entry, admitted.output === '1' && !admitted.error, 'the session is admitted while the proposal waits');
    const pending = b.send(`${operator} ${approve(ids.op2, proposal)} commit;`);
    check(entry, await waitingOnLock(b.name), 'the second operator\'s approval waits for the admitted request');
    await a.send('commit;');
    const approved = await pending;
    check(entry, last(approved) === 'revoked,false' && !approved.error, 'the approval commits after it');
    const next = await a.send(`${begin} ${context(who, ids.clinicA)} ${readPatient(ids.patientA)}`);
    check(entry, REFUSED.test(next.error), `the next request is refused (${firstLine(next.error)})`);
    await a.send('rollback;');
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
