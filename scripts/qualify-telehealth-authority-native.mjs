/** Fictional source-only native PostgreSQL lock tests against exact candidate
 * 117. No cloud transport, external URL, provider, credential input or managed
 * role admission. Historical reports from contract/1 tested only 114. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (process.platform !== 'win32' || args.length !== 4 || args[0] !== '--binary-directory' || args[2] !== '--driver-directory'
  || !isAbsolute(args[1]) || !isAbsolute(args[3])) throw Error('telehealth_authority_native_arguments_refused');
const bin = realpathSync(args[1]), driver = realpathSync(args[3]);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('source_commit_refused');
const require = createRequire(join(driver, 'package.json'));
const { Client } = require('pg');
const { compileTelehealthAuthorityRestrictedOwnerSource } = await import(pathToFileURL(join(root, 'scripts/compile-telehealth-authority-source.mjs')));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const refuse = category => { throw Error(category); };
const source = () => {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() !== sourceCommit
    || execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()) refuse('source_changed');
};
const restrictedOwner = true;
source();
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH'].includes(k.toUpperCase())));
const run = (name, args) => {
  const result = spawnSync(join(bin, name + '.exe'), args, { env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 60000,
    maxBuffer: 1024 * 1024, stdio: name === 'pg_ctl' && args.at(-1) === 'start' ? 'ignore' : 'pipe' });
  if (result.error || result.status !== 0) refuse('native_process_failed_' + name);
  return (result.stdout ?? '').trim();
};
if (run('postgres', ['--version']) !== 'postgres (PostgreSQL) 17.7'
  || JSON.parse(readFileSync(join(driver, 'node_modules/pg/package.json'), 'utf8')).version !== '8.16.3') refuse('native_versions_refused');
const runs = join(root, 'dist/native-authority-runs'); mkdirSync(runs, { recursive: true });
const directory = mkdtempSync(join(runs, 'authority-pg17-'));
const data = join(directory, 'cluster'), passwordFile = join(directory, 'bootstrap-password');
const password = randomBytes(32).toString('hex'), ownerPassword = randomBytes(32).toString('hex');
const database = (restrictedOwner ? 'alp_owner_source_' : 'alp_source_') + randomUUID().replaceAll('-', '');
writeFileSync(passwordFile, password + '\n', { flag: 'wx', mode: 0o600 });
let started = false, admin, compiler, blocker, actor, revoker, configuration, report, artifact, stage = 'bootstrap';
const results = [];
const transferSql = 'select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result';
async function fixture() {
  const [org, practitioner, patient, appointment] = Array.from({ length: 4 }, () => randomUUID());
  const key = { id: 'fictional-' + randomUUID(), bytes: randomBytes(32) };
  await admin.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL NATIVE TEST')", [org]);
  await admin.query('insert into clinical_core.persons(id,subject_key) values($1,$2)', [practitioner, 'subject_' + practitioner.replaceAll('-', '')]);
  await admin.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)", [practitioner, 'subject-' + practitioner]);
  await admin.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')", [org, practitioner]);
  await admin.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')", [patient, org, 'patient_' + patient.replaceAll('-', '')]);
  await admin.query("insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,status,starts_at,ends_at,created_by_person_id,updated_by_person_id) values($1,$2,$3,$4,'telehealth','completed','2026-10-09T17:00:00Z','2026-10-09T17:30:00Z',$4,$4)", [appointment, org, patient, practitioner]);
  await admin.query('insert into clinical_private.telehealth_admission_keys(key_id,secret) values($1,$2)', [key.id, key.bytes]);
  return { org, practitioner, patient, appointment, key };
}
async function context(f) {
  await actor.query('begin'); await actor.query('set local role clinical_core_api');
  await actor.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [f.practitioner, f.org, 'subject-' + f.practitioner]);
}
async function admitted(f, expires = 60000) {
  const now = (await admin.query('select clock_timestamp() as at')).rows[0].at.getTime();
  const transfer = randomUUID(), content = canonical({ telehealth_summary: 'Fictional source summary.' });
  const payload = canonical({ fictional: true }), provenance = canonical([{ sectionKey: 'telehealth_summary', refType: 'telehealth_visit', refId: f.appointment, label: 'Fictional source' }]);
  const digest = sha(payload);
  const admission = canonical({ contract: 'telehealth-chart-admission/1', intent: 'chart_draft', key_id: f.key.id,
    transfer_id: transfer, organization_id: f.org, patient_record_id: f.patient, appointment_id: f.appointment, practitioner_person_id: f.practitioner,
    source_custody: 'telehealth-visit-record', source_record_version: 6, source_revision: 2, source_digest: digest,
    content_sha256: sha(content), payload_sha256: sha(payload), provenance_sha256: sha(provenance), issued_at: new Date(now).toISOString(), expires_at: new Date(now + expires).toISOString() });
  return { args: [f.org, transfer, f.appointment, f.patient, 2, digest, content, payload, provenance, admission, createHmac('sha256', f.key.bytes).update(admission).digest('hex')], expiresAt: now + expires };
}
async function waitForBlocked(pid) {
  for (let i = 0; i < 100; i++) {
    const row = (await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') return row.wait_event;
    await delay(25);
  }
  refuse('native_lock_wait_not_observed');
}
async function counts(f) {
  return (await admin.query(`select (select count(*)::int from clinical_core.telehealth_note_transfers where patient_record_id=$1) transfers,
    (select count(*)::int from clinical_core.clinical_notes where patient_record_id=$1) notes,
    (select count(*)::int from clinical_core.encounters where patient_record_id=$1) encounters`, [f.patient])).rows[0];
}
async function scenario(id, action, destination = false) {
  const f = await fixture();
  let before = { transfers: 0, notes: 0, encounters: 0 };
  if (destination) {
    await context(f);
    const encounter = (await actor.query("select clinical_core.start_encounter($1,$2,'telehealth',$3) id", [f.org, f.patient, f.appointment])).rows[0].id;
    await actor.query('commit'); before = await counts(f);
    await blocker.query('begin'); await blocker.query('select id from clinical_core.encounters where id=$1 for update', [encounter]);
  } else {
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('telehealth-transfer:'||$1::text,0))", [f.appointment]);
  }
  const signed = await admitted(f, action === 'expiry' ? 300 : 60000);
  await context(f); const pid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending = actor.query(transferSql, signed.args).then(value => ({ accepted: true, value }), error => ({ accepted: false, code: error.code, marker: error.message }));
  const observedLock = await waitForBlocked(pid);
  let retirementWait = null, retirement;
  if (action === 'expiry') {
    while ((await admin.query('select clock_timestamp() as at')).rows[0].at.getTime() <= signed.expiresAt + 25) await delay(25);
  } else if (action === 'membership') await admin.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [f.practitioner]);
  else if (action === 'patient') await admin.query('update clinical_core.patient_records set deleted_at=clock_timestamp() where id=$1', [f.patient]);
  else if (action === 'key' && destination) {
    // The current key fence must serialize a retirement that arrives after the
    // transfer already holds its key. Do not wait for retirement while holding
    // the destination lock: that creates a test deadlock, not an app defect.
    await revoker.query('begin');
    const revokerPid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
    retirement = revoker.query('update clinical_private.telehealth_admission_keys set retired_at=clock_timestamp() where key_id=$1', [f.key.id])
      .then(() => ({ succeeded: true }), error => ({ succeeded: false, code: error.code }));
    retirementWait = await waitForBlocked(revokerPid);
    const blockers = (await admin.query('select pg_blocking_pids($1) pids', [revokerPid])).rows[0].pids;
    if (!blockers.includes(pid)) refuse('key_retirement_not_fenced_by_transfer');
    if ((await admin.query('select retired_at from clinical_private.telehealth_admission_keys where key_id=$1', [f.key.id])).rows[0].retired_at !== null)
      refuse('key_retirement_committed_before_transfer');
  } else if (action === 'key') await admin.query('update clinical_private.telehealth_admission_keys set retired_at=clock_timestamp() where key_id=$1', [f.key.id]);
  else refuse('scenario_refused');
  await blocker.query('commit');
  const outcome = await pending;
  // A diagnostic must observe the actual transaction outcome, not silently roll
  // back an erroneously accepted transfer and claim no write occurred.
  await actor.query(outcome.accepted ? 'commit' : 'rollback');
  if (retirement) {
    const retired = await retirement;
    if (!retired.succeeded) refuse('native_key_retirement_failed');
    await revoker.query('commit');
  }
  const after = await counts(f);
  const markers = action === 'expiry' ? /^telehealth_admission_mismatch$/ : action === 'key' ? /^telehealth_admission_(refused|unavailable)$/
    : /^(request_context_refused|clinical_role_required|clinical_patient_required|membership_required|patient_record_not_found|patient_not_found)$/;
  if (retirement) {
    await context(f);
    const retry = await actor.query(transferSql, signed.args).then(() => ({ accepted: true }), error => ({ accepted: false, code: error.code, marker: error.message }));
    await actor.query(retry.accepted ? 'commit' : 'rollback');
    const retryCounts = await counts(f);
    results.push({ id, observedLock, retirementWait, retirementSerialized: true, accepted: outcome.accepted,
      retryAccepted: retry.accepted, retryRefusal: /^[a-z_]+$/.test(retry.marker ?? '') ? retry.marker : null, before, after,
      passed: outcome.accepted && after.transfers === 1 && after.notes === 1 && after.encounters === 1
        && !retry.accepted && markers.test(retry.marker ?? '') && canonical(after) === canonical(retryCounts) });
    return;
  }
  results.push({ id, observedLock, accepted: outcome.accepted, refusalCode: outcome.code ?? null,
    refusalMarker: typeof outcome.marker === 'string' && /^[a-z_]{1,100}$/.test(outcome.marker) ? outcome.marker : null,
    before, after, passed: !outcome.accepted && markers.test(outcome.marker ?? '') && canonical(before) === canonical(after) });
}

async function admittedBeforeRevocation(action) {
  const f = await fixture(), signed = await admitted(f);
  await context(f); const pid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  await actor.query(transferSql, signed.args);
  // The writer has returned, but its transaction is still open. Authority
  // changes must wait on the shared fence until this admitted writer commits.
  await revoker.query('begin');
  const revokerPid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
  const changeSql = action === 'membership' ? "update clinical_core.organization_memberships set status='suspended' where person_id=$1"
    : action === 'patient' ? 'update clinical_core.patient_records set deleted_at=clock_timestamp() where id=$1'
    : action === 'identity' ? "update clinical_core.identities set status='disabled' where person_id=$1"
    : null;
  if (!changeSql) refuse('authority_change_refused');
  const pending = revoker.query(changeSql, [action === 'patient' ? f.patient : f.practitioner])
    .then(() => ({ changed: true }), error => ({ changed: false, code: error.code }));
  const observedLock = await waitForBlocked(revokerPid);
  const blockers = (await admin.query('select pg_blocking_pids($1) pids', [revokerPid])).rows[0].pids;
  if (observedLock !== 'advisory' || !blockers.includes(pid)) refuse('authority_change_not_fenced');
  const beforeCommit = await counts(f);
  await actor.query('commit');
  const change = await pending;
  if (!change.changed) refuse('authority_change_failed');
  await revoker.query('commit');
  const afterCommit = await counts(f);
  let retry;
  try { await context(f); await actor.query(transferSql, signed.args); retry = { accepted: true }; }
  catch (error) { retry = { accepted: false, code: error.code, marker: error.message }; }
  await actor.query(retry.accepted ? 'commit' : 'rollback');
  const afterRetry = await counts(f);
  const allowed = /^(clinical_role_required|patient_not_found|production_identity_required|production_identity_not_bound|request_context_refused|request_context_not_set|production_context_required)$/;
  results.push({ id: action + '_revocation_waits_for_admitted_writer', observedLock, acceptedBeforeRevocation: true,
    retryAccepted: retry.accepted, retryRefusal: /^[a-z_]+$/.test(retry.marker ?? '') ? retry.marker : null,
    beforeCommit, afterCommit, passed: beforeCommit.transfers === 0 && beforeCommit.notes === 0 && beforeCommit.encounters === 0
      && afterCommit.transfers === 1 && afterCommit.notes === 1 && afterCommit.encounters === 1
      && !retry.accepted && allowed.test(retry.marker ?? '') && canonical(afterCommit) === canonical(afterRetry) });
}

try {
  run('initdb', ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--data-checksums']);
  unlinkSync(passwordFile);
  const socket = createServer(); await new Promise((ok, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', ok); });
  const port = socket.address().port; await new Promise((ok, no) => socket.close(error => error ? no(error) : ok()));
  started = true;
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -c max_connections=10 -c shared_buffers=32MB -c timezone=UTC`, '-w', '-t', '30', 'start']);
  configuration = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', ssl: false, connectionTimeoutMillis: 5000,
    query_timeout: 30000, application_name: 'alp-fictional-native-lock-tests', options: '-c statement_timeout=30000 -c search_path=pg_catalog,public' };
  admin = new Client(configuration); await admin.connect();
  if (restrictedOwner) await admin.query(`create role clinical_admin login nosuperuser inherit createdb createrole noreplication nobypassrls password '${ownerPassword}'`);
  await admin.query('create database "' + database + '"' + (restrictedOwner ? ' owner clinical_admin' : '')); await admin.end();
  configuration.database = database;
  const ownerConfiguration = restrictedOwner ? { ...configuration, user: 'clinical_admin', password: ownerPassword } : configuration;
  compiler = new Client(ownerConfiguration); await compiler.connect(); await compiler.query('create extension pgcrypto with schema public');
  const db = { query: (sql, args = []) => compiler.query(sql, [...args]), exec: sql => compiler.query(sql), transaction: async work => {
    await compiler.query('begin'); try { const value = await work(db); await compiler.query('commit'); return value; } catch (e) { await compiler.query('rollback'); throw e; } } };
  artifact = (JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })));
  if (artifact.candidate.contract !== 'telehealth-transfer-authority-candidate/2' || artifact.candidate.migrationCount !== 117
    || artifact.candidate.extensionSha256 !== 'b5e0b07fb80527acdb2f2f631df7efb9caf4209f28dfb7bd4779c1b6eec981b4'
    || artifact.candidate.activation !== 'blocked' || artifact.candidate.phiAllowed !== false) refuse('successor_artifact_refused');
  stage = 'source_compilation';
  const compiled = restrictedOwner ? await compileTelehealthAuthorityRestrictedOwnerSource(db) : await compileTelehealthSchemaNativeSource(db);
  if (compiled.postgresVersion !== '17.7' || compiled.snapshots.map(s => s.migrationCount).join(',') !== (restrictedOwner ? '112,113,114,115,116,117' : '112,113,114')) refuse('source_compile_refused');
  if (restrictedOwner) {
    const last = compiled.snapshots.at(-1);
    if (last.migrationCount !== artifact.candidate.migrationCount || last.migrationReleaseSha256 !== artifact.candidate.migrationReleaseSha256
      || last.assemblySha256 !== artifact.releaseHash) refuse('source_compile_refused');
  } else {
    // Exact current candidate, not the earlier 114-only compiler output. This
    // bootstrap-owner control isolates SQL concurrency; it does not qualify
    // the restricted owner or managed execution profile.
    const assertLedger = async count => {
      const actual = (await compiler.query('select version,name,sha256 from clinical_core.schema_migrations order by version collate "C"')).rows;
      const expected = artifact.manifest.migrations.slice(0, count).map(r => ({ version: r.version, name: r.file.slice(15, -4), sha256: sha(artifact.files[r.file]) }));
      if (canonical(actual) !== canonical(expected)) refuse('exact_candidate_ledger_refused');
    };
    await assertLedger(114);
    for (const count of [115, 116]) await db.transaction(async tx => {
      await assertLedger(count - 1);
      const row = artifact.manifest.migrations[count - 1];
      await tx.exec(artifact.files[row.file]);
      await tx.query('insert into clinical_core.schema_migrations(version,name,sha256) values($1,$2,$3)', [row.version, row.file.slice(15, -4), sha(artifact.files[row.file])]);
      await assertLedger(count);
    });
    await assertLedger(116);
  }
  await compiler.end(); compiler = undefined;
  // Bootstrap privileges are used only for clearly separated fictional fixture
  // administration and blockers. Actual API calls use a non-superuser session
  // and SET LOCAL clinical_core_api; managed Aurora semantics remain unproven.
  admin = new Client(configuration); blocker = new Client(configuration); revoker = new Client(configuration);
  actor = new Client(ownerConfiguration);
  await admin.connect(); await blocker.connect(); await revoker.connect(); await actor.connect();
  stage = 'private_api_denials';
  for (const table of ['clinical_private.telehealth_admission_keys', 'clinical_core.telehealth_note_transfers']) {
    await actor.query('begin'); await actor.query('set local role clinical_core_api');
    let code = null;
    try { await actor.query('select * from ' + table + ' limit 0'); } catch (error) { code = error.code; }
    await actor.query('rollback');
    results.push({ id: table.endsWith('keys') ? 'private_key_read_denied' : 'private_receipt_read_denied', refusalCode: code, passed: code === '42501' });
  }
  stage = 'positive_transfer'; const positive = await fixture(); const signed = await admitted(positive);
  await context(positive); await actor.query(transferSql, signed.args); await actor.query('commit');
  const positiveCounts = await counts(positive);
  results.push({ id: 'fresh_admission_positive', counts: positiveCounts, passed: positiveCounts.transfers === 1 && positiveCounts.notes === 1 && positiveCounts.encounters === 1 });
  stage = 'native_races';
  await scenario('expiry_during_advisory_lock', 'expiry');
  await scenario('membership_revoked_during_advisory_lock', 'membership');
  await scenario('key_retired_during_advisory_lock', 'key');
  await scenario('expiry_during_destination_row_lock', 'expiry', true);
  await scenario('key_retired_during_destination_row_lock', 'key', true);
  await scenario('membership_revoked_during_destination_row_lock', 'membership', true);
  await scenario('patient_deactivated_during_destination_row_lock', 'patient', true);
  await admittedBeforeRevocation('membership');
  await admittedBeforeRevocation('patient');
  await admittedBeforeRevocation('identity');
  report = { contract: 'telehealth-authority-native-source/1', sourceCommit, diagnosticSha256: sha(readFileSync(new URL(import.meta.url))),
    testedArtifact: { contract: artifact.candidate.contract, migrationCount: artifact.candidate.migrationCount,
      migrationReleaseSha256: artifact.candidate.migrationReleaseSha256, assemblySha256: artifact.releaseHash },
    execution: restrictedOwner ? 'local_restricted_owner_source' : 'local_bootstrap_owner_concurrency_control', postgresVersion: '17.7',
    sourceBootstrapOwner: 'postgres', sourceOwner: restrictedOwner ? 'clinical_admin' : 'postgres',
    apiSessionOwner: restrictedOwner ? 'clinical_admin' : 'postgres', apiCallerRole: 'clinical_core_api',
    managedRoleSemanticsVerified: false, hostedVerified: false, upgradeAuthorized: false, providerAuthorized: false, phiAllowed: false, activation: 'blocked',
    passed: results.every(r => r.passed), results };
} catch (error) {
  report = { contract: 'telehealth-native-source-races/2', sourceCommit,
    execution: restrictedOwner ? 'local_restricted_owner_source' : 'local_bootstrap_owner_concurrency_control',
    ...(artifact ? { testedArtifact: { contract: artifact.candidate.contract, migrationCount: artifact.candidate.migrationCount,
      migrationReleaseSha256: artifact.candidate.migrationReleaseSha256, assemblySha256: artifact.releaseHash } } : {}), passed: false, stage,
    databaseErrorCode: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null,
    failure: /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'native_source_run_failed', results,
    phiAllowed: false, activation: 'blocked', upgradeAuthorized: false, providerAuthorized: false };
} finally {
  for (const connection of [actor, blocker, revoker, compiler, admin]) if (connection) await connection.end().catch(() => {});
  if (started) {
    const status = spawnSync(join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { env: childEnv, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!status.error && status.status === 0) run('pg_ctl', ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop']);
    else if (status.error || status.status !== 3) refuse('native_shutdown_unknown');
    const stopped = spawnSync(join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { env: childEnv, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (stopped.error || stopped.status !== 3) refuse('native_shutdown_unconfirmed');
  }
  try { unlinkSync(passwordFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
source(); report.shutdownConfirmed = true;
writeFileSync(join(directory, 'race-qualification.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...report, reportDirectory: directory }));
if (!report.passed) process.exitCode = 1;
