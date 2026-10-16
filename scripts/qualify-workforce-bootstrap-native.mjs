/** Local, disposable two-session qualification of the UNREGISTERED, BLOCKED new-clinic bootstrap candidate.
 *
 * PGlite has one connection, so it can order calls but not overlap them. This script starts a throwaway PostgreSQL
 * cluster with no TCP listener (a private Unix socket only), loads the assembled production schema, the onboarding
 * parents, the current-membership setter, the approval-authority successor and the bootstrap candidate, switches the
 * candidate's release row on inside that cluster only, inserts fictional rows, and drives two psql sessions:
 *
 *   A. one account, one request id, two sessions at once: the second waits, then answers the first's clinic as a duplicate;
 *   B. one account, two request ids at once (two tabs): the second waits, then is refused; exactly one clinic exists;
 *   C. two accounts, the same clinic name at once: neither waits for the other; two separate clinics, each owner admitted
 *      only to their own;
 *   D. an operator suspension issued while the owner's clinical request is admitted waits for it; the next request is refused;
 *   E. an owner request issued while a suspension is uncommitted waits for it, then is refused.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-workforce-bootstrap-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('workforce_bootstrap_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('workforce_bootstrap_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('workforce_bootstrap_native_arguments_refused');
const BOOTSTRAP_NATIVE_FILES = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
  'infra/aws-clinical-core/source-candidates/workforce-new-clinic-bootstrap.sql',
];
const digest = (email) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`workforce_bootstrap_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-bootstrap-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'workforce-bootstrap-native/1', sourceCommit, sourceClean, postgres: null, files: [], scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidates are loaded into this throwaway cluster only; nothing is registered, applied or deployed.',
  'Whether RDS Data API transactions hold these row locks across statements is not shown here.',
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
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c timezone=UTC -c max_connections=10`, '-w', '-t', '30', 'start']);
  started = true;
  const psql = (sql, database = 'alp') => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  psql('create database alp', 'postgres');
  psql('create extension if not exists pgcrypto');
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  if (manifest.migrations.some((m) => /onboarding|approval-authority|current-membership|bootstrap/.test(m.file))) throw Error('workforce_bootstrap_native_candidate_already_registered');
  for (const migration of manifest.migrations) psql(files[migration.file]);
  for (const file of BOOTSTRAP_NATIVE_FILES) {
    const text = readFileSync(join(root, file), 'utf8');
    psql(text);
    report.files.push({ file, sha256: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') });
  }

  const open = (name) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', 'alp', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
    const child = spawn(command, full, { env: { ...childEnv, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', marker = 0;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    const session = {
      send(sql) {
        const id = `__done_${name}_${++marker}__`;
        const startOut = output.length, startErr = errors.length;
        child.stdin.write(`${sql}\n\\echo ${id}\n`);
        return new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error(`workforce_bootstrap_native_session_timeout:${name}`)), 60_000);
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
      child,
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
  psql("update clinical_private.workforce_clinic_bootstrap_release set enabled=true where singleton");
  const operator = randomUUID();
  psql(`insert into clinical_private.workforce_platform_operators(operator_subject,status) values('${operator}','active')`);
  const applicant = (label) => { const subject = randomUUID(); return { subject, email: `${label}.${subject.slice(0, 8)}@applicant.fictional.example` }; };
  const bootstrapOnce = (who, request, label) => `begin; set local role clinical_workforce_application;
    select (clinical_private.bootstrap_workforce_clinic('${request}','${who.subject}','${digest(who.email)}','${label}','verified_email_and_mfa'))::text;`;
  const clinicsOf = (who) => Number(psql(`select count(*) from clinical_private.workforce_clinic_bootstraps where lower(identity_subject)=lower('${who.subject}')`));
  const admittedSql = (who, clinic) => `set local role clinical_core_api; select clinical_private.set_current_workforce_context('${who.subject}','${clinic}','clinical_data') is not null;`;
  const admitted = (who, clinic) => {
    try { psql(`begin; ${admittedSql(who, clinic)} commit;`); return true; } catch (error) { if (/workforce_membership_refused/.test(String(error))) return false; throw error; }
  };
  const created = (who, label) => JSON.parse(psql(`begin; set local role clinical_workforce_application;
    select (clinical_private.bootstrap_workforce_clinic('${randomUUID()}','${who.subject}','${digest(who.email)}','${label}','verified_email_and_mfa'))::text; commit;`));
  const check = (scenario, condition, detail) => { scenario.checks.push({ detail, passed: Boolean(condition) }); };
  const scenario = async (id, body) => {
    const entry = { id, checks: [] };
    const a = open(`alp_bs_${id}_a`), b = open(`alp_bs_${id}_b`);
    try { await body(entry, a, b, `alp_bs_${id}_a`, `alp_bs_${id}_b`); } finally { a.close(); b.close(); }
    report.scenarios.push(entry);
  };
  const parsed = (output) => { try { return JSON.parse(output); } catch { return null; } };

  // A. One account, one request id, two sessions at once.
  await scenario('same-request-twice', async (s, a, b, _nameA, nameB) => {
    const who = applicant('same.request'), request = randomUUID();
    const first = parsed((await a.send(bootstrapOnce(who, request, 'FICTIONAL RACE CLINIC'))).output);
    check(s, first?.duplicate === false, 'session A creates the clinic');
    const pending = b.send(bootstrapOnce(who, request, 'FICTIONAL RACE CLINIC'));
    check(s, await waitingOnLock(nameB), 'session B waits on the account\'s lock');
    await a.send('commit;');
    const second = await pending;
    const answer = parsed(second.output);
    check(s, answer?.duplicate === true && answer?.organizationId === first?.organizationId && !second.error, 'session B answers the same clinic as a duplicate');
    await b.send('commit;');
    check(s, clinicsOf(who) === 1, 'exactly one clinic exists for the account');
  });

  // B. One account, two request ids at once (two tabs).
  await scenario('two-tabs', async (s, a, b, _nameA, nameB) => {
    const who = applicant('two.tabs');
    const first = parsed((await a.send(bootstrapOnce(who, randomUUID(), 'FICTIONAL TAB ONE'))).output);
    check(s, first?.duplicate === false, 'session A creates the clinic');
    const pending = b.send(bootstrapOnce(who, randomUUID(), 'FICTIONAL TAB TWO'));
    check(s, await waitingOnLock(nameB), 'session B waits on the account\'s lock');
    await a.send('commit;');
    const second = await pending;
    check(s, /workforce_clinic_bootstrap_exists/.test(second.error), 'session B is refused by name after seeing the first clinic');
    await b.send('rollback;');
    check(s, clinicsOf(who) === 1, 'exactly one clinic exists for the account');
    check(s, Number(psql("select count(*) from clinical_core.organizations where organization_label='FICTIONAL TAB TWO'")) === 0, 'the second clinic was never created');
  });

  // C. Two accounts, the same name, at once.
  await scenario('two-accounts-same-name', async (s, a, b, _nameA, nameB) => {
    const one = applicant('same.name.one'), two = applicant('same.name.two');
    const first = parsed((await a.send(bootstrapOnce(one, randomUUID(), 'FICTIONAL SAME NAME'))).output);
    const secondPending = b.send(bootstrapOnce(two, randomUUID(), 'FICTIONAL SAME NAME'));
    const waited = await waitingOnLock(nameB);
    const second = parsed((await secondPending).output);
    check(s, !waited, 'session B does not wait for another account');
    await a.send('commit;'); await b.send('commit;');
    check(s, first?.organizationId && second?.organizationId && first.organizationId !== second.organizationId, 'two separate clinics exist');
    check(s, admitted(one, first.organizationId) && !admitted(one, second.organizationId), 'the first owner is admitted only to their own clinic');
    check(s, admitted(two, second.organizationId) && !admitted(two, first.organizationId), 'the second owner is admitted only to their own clinic');
  });

  // D. A suspension issued while the owner's request is admitted waits for it.
  await scenario('suspension-waits-for-admitted-request', async (s, a, b, _nameA, nameB) => {
    const who = applicant('suspend.later'); const clinic = created(who, 'FICTIONAL SUSPEND LATER').organizationId;
    const inFlight = await a.send(`begin; ${admittedSql(who, clinic)}`);
    check(s, inFlight.output === 't' && !inFlight.error, 'session A, the owner, is admitted');
    const pending = b.send(`begin; set local role clinical_workforce_operator;
      select clinical_private.suspend_bootstrapped_workforce_clinic('${clinic}','${operator}','security_concern')->>'status';`);
    check(s, await waitingOnLock(nameB), 'the suspension waits for the admitted request');
    await a.send('commit;');
    const suspended = await pending;
    check(s, suspended.output === 'suspended' && !suspended.error, 'the suspension then lands');
    await b.send('commit;');
    check(s, !admitted(who, clinic), 'the owner\'s next request is refused');
  });

  // E. An owner request issued while a suspension is uncommitted waits for it, then is refused.
  await scenario('request-waits-for-pending-suspension', async (s, a, b, nameA) => {
    const who = applicant('suspend.first'); const clinic = created(who, 'FICTIONAL SUSPEND FIRST').organizationId;
    const suspending = await b.send(`begin; set local role clinical_workforce_operator;
      select clinical_private.suspend_bootstrapped_workforce_clinic('${clinic}','${operator}','security_concern')->>'status';`);
    check(s, suspending.output === 'suspended' && !suspending.error, 'session B suspends, uncommitted');
    const pending = a.send(`begin; ${admittedSql(who, clinic)}`);
    check(s, await waitingOnLock(nameA), 'the owner\'s request waits for the suspension');
    await b.send('commit;');
    const refused = await pending;
    check(s, /workforce_membership_refused/.test(refused.error), 'the owner\'s request is refused on the committed suspension');
    await a.send('rollback;');
  });
  report.passed = report.scenarios.length === 5 && report.scenarios.every((entry) => entry.checks.length > 0 && entry.checks.every((c) => c.passed));
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
