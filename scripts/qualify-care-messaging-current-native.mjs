/** Local, disposable two-session qualification of the BLOCKED care-messaging current-context successor: a practitioner
 * reply through the restricted login's fifth proxy while the membership or the clinic changes in another session.
 *
 * PGlite has one connection. This script starts a throwaway PostgreSQL cluster with no TCP listener (a private Unix
 * socket only), makes `clinical_core_qualification` its only connectable non-template database (what the CONNECT
 * isolation does on the real cluster), loads the 112-migration qualification schema, the current-membership setter,
 * the restricted credential and the successor, inserts fictional rows, and drives two psql sessions:
 *
 *   admitted first      a reply admitted through the proxy holds the membership row; a removal waits for it to commit,
 *                       and the next reply is refused;
 *   removal pending     a reply asked for while an uncommitted removal holds the membership row waits, re-reads the
 *                       committed row, is refused, and writes nothing;
 *   clinic pending      the same with a clinic suspension;
 *   cross-clinic        a practitioner of a sibling clinic cannot bind into this one through the proxy.
 *
 * The replies run as the restricted login under its API role (SET only, no INHERIT), calling only proxies. It never
 * connects to an existing database, reads no database URL or credential, and writes nothing outside its own temporary
 * directory, which it removes. Usage:
 *   node scripts/qualify-care-messaging-current-native.mjs --binary-directory /usr/lib/postgresql/16/bin [--run-as postgres] [--out file]
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
if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'postgres'))) throw Error('care_current_native_arguments_refused');
if (userInfo().uid === 0 && !runAs) throw Error('care_current_native_root_requires_run_as');
if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) throw Error('care_current_native_arguments_refused');
const CANDIDATES = ['workforce-current-membership-context.sql', 'care-messaging-qualification-login.sql', 'care-messaging-qualification-current-context.sql']
  .map((file) => join('infra/aws-clinical-core/source-candidates', file));
const SCHEMA = 'clinical_care_messaging_qualification', API = 'clinical_care_messaging_qualification_api', LOGIN = 'clinical_care_messaging_qualification_login';

const asUser = (command, commandArgs) => runAs ? ['runuser', ['-u', runAs, '--', command, ...commandArgs]] : [command, commandArgs];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(name, commandArgs, input) {
  const [command, full] = asUser(join(bin, name), commandArgs);
  const result = spawnSync(command, full, { env: childEnv, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`care_current_native_process_failed:${name}:${(result.stderr ?? '').slice(-400)}`);
  return (result.stdout ?? '').trim();
}

const directory = mkdtempSync(join(tmpdir(), 'alp-care-current-native-'));
const data = join(directory, 'cluster'), socket = join(directory, 'socket');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceClean = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'infra'], { cwd: root, encoding: 'utf8' }).trim() === '';
const report = { contract: 'care-messaging-current-native/1', sourceCommit, sourceClean, postgres: null, scenarios: [], limitations: [
  'A local disposable PostgreSQL cluster with fictional rows; not Aurora, the RDS Data API, a deployed Lambda or a hosted run.',
  'The candidates are loaded into this throwaway cluster only; nothing is registered, applied or deployed, and no login is enabled.',
  'Sessions assume the restricted login with SET SESSION AUTHORIZATION from a local superuser; no password or secret exists.',
] };
const DATABASE = 'clinical_core_qualification';
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
  const psql = (sql, database = DATABASE) => run('psql', ['-h', socket, '-U', 'postgres', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  psql(`create database ${DATABASE}`, 'postgres');
  // The CONNECT isolation's effect, in this throwaway cluster only: no sibling database is connectable through PUBLIC.
  psql('revoke connect on database postgres from public', 'postgres');
  psql('create extension if not exists pgcrypto');
  const { manifest, files } = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (manifest.migrations.length !== 112) throw Error('care_current_native_release_refused');
  // As the production migration runner does (src/server/clinical-core/production-migrations.ts): the ledger first, then
  // each migration and its ledger row. The 107-112 successors read the ledger.
  psql(`create schema if not exists clinical_core;
    create table if not exists clinical_core.schema_migrations (version text primary key, name text not null,
      sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), applied_at timestamptz not null default clock_timestamp());`);
  for (const migration of manifest.migrations) {
    const sql = files[migration.file];
    psql(sql);
    psql(`insert into clinical_core.schema_migrations(version,name,sha256) values('${migration.version}','${migration.file.slice(15, -4)}','${createHash('sha256').update(sql).digest('hex')}')`);
  }
  for (const candidate of CANDIDATES) psql(readFileSync(join(root, candidate), 'utf8'));

  const ids = Object.fromEntries(['org', 'sibling', 'owner', 'ownerSub', 'staff', 'staffSub', 'siblingStaff', 'siblingSub', 'patient', 'connection', 'artifact']
    .map((key) => [key, randomUUID()]));
  psql(`insert into clinical_core.organizations(id,organization_label) values('${ids.org}','FICTIONAL NATIVE'),('${ids.sibling}','FICTIONAL NATIVE SIBLING');
    insert into clinical_core.persons(id,subject_key) values ${[ids.owner, ids.staff, ids.siblingStaff].map((id) => `('${id}','subject_${id.replaceAll('-', '')}')`).join(',')};
    insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values
      ('${ids.owner}','consumer','${ids.ownerSub}',true),('${ids.staff}','workforce','${ids.staffSub}',true),('${ids.siblingStaff}','workforce','${ids.siblingSub}',true);
    insert into clinical_core.organization_memberships(organization_id,person_id,role) values('${ids.org}','${ids.staff}','practitioner'),('${ids.sibling}','${ids.siblingStaff}','practitioner');
    insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values('${ids.patient}','${ids.org}','patient_${ids.patient.replaceAll('-', '')}','Fictional','Native');
    insert into clinical_core.patient_connections(id,organization_id,patient_record_id,consumer_person_id,state,verified_at) values('${ids.connection}','${ids.org}','${ids.patient}','${ids.owner}','verified',clock_timestamp());
    insert into clinical_core.consent_artifacts(id,organization_id,scope,artifact_version,content_sha256,jurisdiction,status,approved_at,approved_by_person_id)
      values('${ids.artifact}','${ids.org}','messaging','fictional-native','${'a'.repeat(64)}','TEST','approved',clock_timestamp(),'${ids.staff}');
    insert into clinical_core.consent_grants(organization_id,patient_record_id,connection_id,artifact_id,scope,status,method,representative_authority,version,recorded_by_person_id)
      values('${ids.org}','${ids.patient}','${ids.connection}','${ids.artifact}','messaging','granted','patient_app','self',1,'${ids.owner}');`);
  const asRestricted = `begin; set local session authorization ${LOGIN}; set local role ${API};`;
  const json = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const threadId = psql(`${asRestricted}
    select ${SCHEMA}.set_request_context('${ids.owner}','${ids.org}','consumer','${ids.ownerSub}','clinical_data','production-clinical','clinical_phi');
    select ${SCHEMA}.request(${json({ action: 'send', requestId: randomUUID(), connectionId: ids.connection, subject: 'Fictional native question',
      body: 'FICTIONAL native patient message', acknowledgement: 'care-messages/1' })})->>'threadId'; commit;`).split('\n').filter(Boolean).pop();
  if (!/^[0-9a-f-]{36}$/.test(threadId ?? '')) throw Error('care_current_native_thread_refused');

  const open = (name) => {
    const [command, full] = asUser(join(bin, 'psql'), ['-h', socket, '-U', 'postgres', '-d', DATABASE, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0']);
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
          const deadline = setTimeout(() => reject(Error(`care_current_native_session_timeout:${name}`)), 60_000);
          const check = () => {
            if (output.includes(id, startOut)) {
              clearTimeout(deadline); child.stdout.off('data', check);
              resolve({ output: output.slice(startOut, output.indexOf(id, startOut)).trim(), error: errors.slice(startErr).trim() });
            }
          };
          child.stdout.on('data', check); check();
        });
      },
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
  const bind = (sub, clinic = ids.org) => `select ${SCHEMA}.set_current_workforce_context('${sub}','${clinic}')->>'role';`;
  const reply = () => `select ${SCHEMA}.request(${json({ action: 'send', requestId: randomUUID(), connectionId: ids.connection, threadId,
    body: 'FICTIONAL native practitioner reply', acknowledgement: 'care-messages/1' })})->>'messageId';`;
  const replies = () => Number(psql(`select count(*) from clinical_core.messages where body='FICTIONAL native practitioner reply'`));
  const membership = (status) => `update clinical_core.organization_memberships set status='${status}' where organization_id='${ids.org}' and person_id='${ids.staff}';`;
  const clinic = (status) => `update clinical_core.organizations set status='${status}' where id='${ids.org}';`;
  const REFUSED = /\bworkforce_membership_refused\b/;
  let sequence = 0;
  const pair = () => { sequence += 1; return [open(`alp_cc_a${sequence}`), open(`alp_cc_b${sequence}`), `alp_cc_a${sequence}`, `alp_cc_b${sequence}`]; };
  const scenario = (id) => { const entry = { id, checks: [] }; report.scenarios.push(entry); return entry; };
  const check = (entry, condition, detail) => { entry.checks.push({ detail, passed: Boolean(condition) }); };
  const closeAll = (...list) => { for (const s of list) s.child.stdin.end(); };

  {
    const entry = scenario('admitted-reply-holds-off-the-membership-removal');
    const [a, b, , bName] = pair();
    const before = replies();
    await a.send(asRestricted);
    const bound = await a.send(bind(ids.staffSub));
    check(entry, bound.output === 'practitioner' && !bound.error, `the practitioner binds through the proxy as the restricted role${bound.error ? `: ${bound.error}` : ''}`);
    const pending = b.send(`begin; ${membership('suspended')} commit;`);
    check(entry, await waitingOnLock(bName), 'the removal waits on the membership row the admitted reply holds');
    const written = await a.send(reply());
    check(entry, /^[0-9a-f-]{36}$/.test(written.output) && !written.error, `the admitted reply is stored${written.error ? `: ${written.error}` : ''}`);
    await a.send('commit;');
    check(entry, !(await pending).error, 'the removal commits after the reply commits');
    const next = await a.send(`${asRestricted} ${bind(ids.staffSub)}`);
    check(entry, REFUSED.test(next.error), 'the next reply, with the same already-issued identity, is refused');
    await a.send('rollback;');
    check(entry, replies() === before + 1, 'exactly one reply was stored');
    psql(membership('active'));
    closeAll(a, b);
  }
  for (const [id, change, restore, label] of [
    ['reply-waiting-on-a-pending-removal-is-refused', membership('suspended'), membership('active'), 'membership removal'],
    ['reply-waiting-on-a-pending-clinic-suspension-is-refused', clinic('suspended'), clinic('active'), 'clinic suspension'],
  ]) {
    const entry = scenario(id);
    const [a, b, aName] = pair();
    const before = replies();
    await b.send(`begin; ${change}`);
    await a.send(asRestricted);
    const pending = a.send(`${bind(ids.staffSub)} ${reply()}`);
    check(entry, await waitingOnLock(aName), `the reply waits on the row the uncommitted ${label} holds`);
    await b.send('commit;');
    const refused = await pending;
    check(entry, REFUSED.test(refused.error), `after the ${label} commits, the reply is refused`);
    await a.send('rollback;');
    check(entry, replies() === before, 'no partial write: no reply stored');
    psql(restore);
    closeAll(a, b);
  }
  {
    const entry = scenario('a-sibling-clinic-practitioner-cannot-bind-into-this-clinic');
    const [a] = pair();
    const before = replies();
    const crossed = await a.send(`${asRestricted} ${bind(ids.siblingSub)} ${reply()}`);
    check(entry, REFUSED.test(crossed.error), 'the sibling practitioner is refused at the binding');
    await a.send('rollback;');
    const own = await a.send(`${asRestricted} ${bind(ids.siblingSub, ids.sibling)} rollback;`);
    check(entry, !own.error, 'the same practitioner binds into their own clinic (the refusal is the clinic, not the person)');
    check(entry, replies() === before, 'no reply stored');
    closeAll(a);
  }
  {
    const entry = scenario('the-restricted-role-reaches-the-setter-only-through-its-proxy');
    const [a] = pair();
    const direct = await a.send(`${asRestricted} select clinical_private.set_current_workforce_context('${ids.staffSub}','${ids.org}','clinical_data');`);
    check(entry, /permission denied/.test(direct.error), 'calling the setter directly is refused');
    await a.send('rollback;');
    const legacyWrite = await a.send(`${asRestricted} select clinical_core.create_patient_profile('${ids.org}','Fictional','Native');`);
    check(entry, /permission denied/.test(legacyWrite.error), 'an unrelated chart write is refused');
    await a.send('rollback;');
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
