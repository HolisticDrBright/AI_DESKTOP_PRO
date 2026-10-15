/** Local, disposable two-session qualification of the UNREGISTERED, BLOCKED onboarding approval-authority candidate.
 *
 * PGlite has one connection, so it can order two decisions but cannot make them overlap. This script starts a
 * throwaway PostgreSQL cluster with no TCP listener (a private Unix socket only), loads the assembled production schema,
 * the onboarding parents, the current-membership setter and the successor, inserts fictional rows, and drives two psql
 * sessions through the races the decision must survive:
 *
 *   A. two administrators approve the same request at once: the second waits, then answers the stored decision;
 *   B. approve first, reject second: the rejection waits, then is a conflict;
 *   C. reject first, approve second: the approval waits, then is a conflict, and no membership exists;
 *   D. a demotion issued while an approval is in flight waits for the approval to commit;
 *   E. a demotion committed-pending before the approval: the approval waits, re-reads the demoted row and is refused;
 *   F. a revocation issued while the practitioner's request is in flight waits for it; the next request is refused;
 *   G. control: under the parent review function and the legacy claim context, the same demotion does not wait, so D and
 *      E measure the successor's locks, not the harness.
 *
 * It never connects to an existing database, reads no database URL or credential, and writes nothing outside its own
 * temporary directory, which it removes. Usage:
 *   node scripts/qualify-workforce-onboarding-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('workforce_onboarding_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('workforce_onboarding_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('workforce_onboarding_native_arguments_refused');
const ONBOARDING_NATIVE_FILES = [
  'infra/aws-clinical-core/source-candidates/workforce-token-binding-lookup.sql',
  'infra/aws-clinical-core/source-candidates/workforce-clinic-approved-onboarding.sql',
  'infra/aws-clinical-core/production-candidates/workforce-invitation-role-repair.sql',
  'infra/aws-clinical-core/source-candidates/workforce-join-review-uniform-refusal.sql',
  'infra/aws-clinical-core/source-candidates/workforce-current-membership-context.sql',
  'infra/aws-clinical-core/source-candidates/workforce-onboarding-approval-authority.sql',
];
const digest = (email) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`workforce_onboarding_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-onboarding-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'workforce-onboarding-native/1', sourceCommit, sourceClean, postgres: null, files: [], scenarios: [], limitations: [
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
  if (manifest.migrations.some((m) => /onboarding|approval-authority|current-membership/.test(m.file))) throw Error('workforce_onboarding_native_candidate_already_registered');
  for (const migration of manifest.migrations) psql(files[migration.file]);
  for (const file of ONBOARDING_NATIVE_FILES) {
    const text = readFileSync(join(root, file), 'utf8');
    psql(text);
    report.files.push({ file, sha256: createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') });
  }

  const clinic = randomUUID();
  const people = {};
  const addPerson = (label, role) => {
    const p = { person: randomUUID(), subject: randomUUID(), email: `${label}.${randomUUID().slice(0, 8)}@clinic.fictional.example` };
    psql(`insert into clinical_core.persons(id,subject_key) values('${p.person}','subject_${p.person.replaceAll('-', '')}');
      insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values('${p.person}','workforce','${p.subject}',true);
      insert into clinical_core.workforce_identity_directory(person_id,identity_subject,email_sha256) values('${p.person}','${p.subject}','${digest(p.email)}');
      ${role ? `insert into clinical_core.organization_memberships(organization_id,person_id,role,status) values('${clinic}','${p.person}','${role}','active');` : ''}`);
    people[label] = p;
    return p;
  };
  psql(`insert into clinical_core.organizations(id,organization_label) values('${clinic}','FICTIONAL NATIVE CLINIC')`);
  const owner = addPerson('owner', 'owner'), adminOne = addPerson('admin.one', 'admin'), adminTwo = addPerson('admin.two', 'admin');
  const submit = () => {
    const request = randomUUID(), subject = randomUUID(), email = `${subject.slice(0, 8)}@applicant.fictional.example`;
    psql(`begin; set local role clinical_workforce_application;
      select clinical_private.submit_workforce_access_request('${request}','${subject}','${digest(email)}','join','${clinic}',null); commit;`);
    return { request, subject, email };
  };
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
          const deadline = setTimeout(() => reject(Error(`workforce_onboarding_native_session_timeout:${name}`)), 60_000);
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
  const bind = (who) => `set local role clinical_core_api; select clinical_private.set_current_workforce_context('${who.subject}','${clinic}','clinical_data') is not null;`;
  const decide = (app, approve) => approve
    ? `select clinical_core.review_workforce_join_request_v2('${app.request}',true,'identity_confirmed_by_clinic','${digest(app.email)}')->>'duplicate';`
    : `select clinical_core.review_workforce_join_request_v2('${app.request}',false,'not_known_to_clinic',null)->>'duplicate';`;
  const decisions = (app) => Number(psql(`select count(*) from clinical_private.workforce_access_events where request_id='${app.request}' and action<>'submitted'`));
  const statusOf = (app) => psql(`select status from clinical_private.workforce_access_requests where id='${app.request}'`);
  const memberships = (app) => Number(psql(`select count(*) from clinical_core.organization_memberships m join clinical_core.identities i on i.person_id=m.person_id
    where i.identity_pool='workforce' and i.identity_subject='${app.subject}' and m.organization_id='${clinic}'`));
  const roleOf = (who) => psql(`select role||'/'||status from clinical_core.organization_memberships where organization_id='${clinic}' and person_id='${who.person}'`);
  const setRole = (who, role) => `update clinical_core.organization_memberships set role='${role}' where organization_id='${clinic}' and person_id='${who.person}';`;
  const check = (scenario, condition, detail) => { scenario.checks.push({ detail, passed: Boolean(condition) }); };
  const scenario = async (id, body) => {
    const entry = { id, checks: [] };
    const a = open(`alp_ob_${id}_a`), b = open(`alp_ob_${id}_b`);
    try { await body(entry, a, b, `alp_ob_${id}_a`, `alp_ob_${id}_b`); } finally { a.close(); b.close(); }
    report.scenarios.push(entry);
  };

  // A and B/C: concurrent reviewers, and both orders of opposing decisions.
  for (const [id, firstApproves, secondApproves] of [['approve-approve', true, true], ['approve-then-reject', true, false], ['reject-then-approve', false, true]]) {
    await scenario(id, async (s, a, b, _nameA, nameB) => {
      const app = submit();
      await a.send(`begin; ${bind(adminOne)}`);
      const first = await a.send(decide(app, firstApproves));
      check(s, first.output === 'false' && !first.error, 'session A decides first');
      await b.send(`begin; ${bind(adminTwo)}`);
      const pending = b.send(decide(app, secondApproves));
      check(s, await waitingOnLock(nameB), 'session B waits for session A\'s decision');
      await a.send('commit;');
      const second = await pending;
      if (firstApproves === secondApproves) check(s, second.output === 'true' && !second.error, 'session B answers the stored decision as a duplicate');
      else check(s, /workforce_review_conflict/.test(second.error), 'session B is refused as a conflict');
      await b.send(second.error ? 'rollback;' : 'commit;');
      check(s, decisions(app) === 1, 'exactly one decision event exists');
      check(s, statusOf(app) === (firstApproves ? 'approved' : 'rejected'), 'the first committed decision stands');
      check(s, memberships(app) === (firstApproves ? 1 : 0), firstApproves ? 'exactly one membership exists' : 'no membership exists');
    });
  }

  // D. Demotion while an approval is in flight: it waits for the approval.
  await scenario('demotion-waits-for-decision', async (s, a, b, _nameA, nameB) => {
    const app = submit(), reviewer = addPerson('admin.d', 'admin');
    await a.send(`begin; ${bind(reviewer)}`);
    const decided = await a.send(decide(app, true));
    check(s, decided.output === 'false' && !decided.error, 'session A approves');
    const pending = b.send(`begin; ${setRole(reviewer, 'practitioner')} commit;`);
    check(s, await waitingOnLock(nameB), 'session B demotion waits on the reviewer membership session A locked');
    await a.send('commit;');
    const demoted = await pending;
    check(s, !demoted.error, 'session B demotion commits after the decision');
    check(s, statusOf(app) === 'approved' && roleOf(reviewer) === 'practitioner/active', 'the decision stands and the demotion is applied after it');
  });

  // E. Demotion pending before the approval: the approval waits, then refuses on the committed row.
  await scenario('pending-demotion-refuses-decision', async (s, a, b, nameA) => {
    const app = submit(), reviewer = addPerson('admin.e', 'admin');
    await b.send(`begin; ${setRole(reviewer, 'practitioner')}`);
    await a.send('begin;');
    const pending = a.send(`${bind(reviewer)} ${decide(app, true)}`);
    check(s, await waitingOnLock(nameA), 'session A waits on the uncommitted demotion');
    await b.send('commit;');
    const refused = await pending;
    check(s, /workforce_application_not_found/.test(refused.error), 'session A re-reads the demoted row and is refused as not found');
    await a.send('rollback;');
    check(s, statusOf(app) === 'pending' && decisions(app) === 0, 'nothing was decided');
  });

  // F. Revocation while the practitioner's own request is in flight: it waits; the next request is refused.
  await scenario('revocation-waits-then-fences', async (s, a, b, _nameA, nameB) => {
    const member = addPerson('practitioner.f', 'practitioner');
    const membership = psql(`select id from clinical_core.organization_memberships where organization_id='${clinic}' and person_id='${member.person}'`);
    await a.send(`begin; ${bind(member)}`);
    await b.send(`begin; ${bind(owner)}`);
    const pending = b.send(`select clinical_core.revoke_workforce_membership('${membership}','left_clinic')->>'status';`);
    check(s, await waitingOnLock(nameB), 'the revocation waits for the practitioner\'s admitted request');
    await a.send('commit;');
    const revoked = await pending;
    check(s, revoked.output === 'suspended' && !revoked.error, 'the revocation then commits');
    await b.send('commit;');
    const next = await a.send(`begin; ${bind(member)}`);
    check(s, /workforce_membership_refused/.test(next.error), 'the practitioner\'s next request is refused, whatever token it carries');
    await a.send('rollback;');
    check(s, Number(psql(`select count(*) from clinical_private.workforce_membership_revocations where membership_id='${membership}'`)) === 1, 'one reasoned revocation is recorded');
  });

  // G. Control: the parent's review under the legacy claim context takes no lock on the reviewer's membership.
  await scenario('control-parent-review-does-not-fence', async (s, a, b) => {
    const app = submit(), reviewer = addPerson('admin.g', 'admin');
    await a.send(`begin; select clinical_private.set_request_context('${reviewer.person}','${clinic}','workforce','${reviewer.subject}','clinical_data','production-clinical','clinical_phi');`);
    const decided = await a.send(`select (clinical_core.review_workforce_join_request('${app.request}',true))->>'status';`);
    check(s, decided.output === 'approved' && !decided.error, `session A approves through the parent${decided.error ? `: ${decided.error}` : ''}`);
    const demoted = await b.send(`begin; ${setRole(reviewer, 'practitioner')} commit;`);
    check(s, !demoted.error && roleOf(reviewer) === 'practitioner/active', 'session B demotion commits at once, while the parent\'s decision is still open');
    await a.send('rollback;');
  });
  report.passed = report.scenarios.length === 7 && report.scenarios.every((entry) => entry.checks.length > 0 && entry.checks.every((c) => c.passed));
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
