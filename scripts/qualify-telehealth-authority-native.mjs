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
import { TELEHEALTH_AUTHORITY_SQL_SHA256 } from './telehealth-transfer-authority-candidate.mjs';
import { completeNativeAuthorityCoverage, REQUIRED_NATIVE_AUTHORITY_SCENARIOS } from './telehealth-authority-native-coverage.mjs';

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
const projectRequire = createRequire(join(root, 'package.json'));
const { buildSync } = projectRequire('esbuild');
const adapterBundle = join(directory, 'request-adapter.cjs'), metadataBundle = join(directory, 'credential-metadata.cjs');
for (const [entry, outfile] of [['rds-data-database.ts', adapterBundle], ['rds-runtime-credential.ts', metadataBundle]])
  buildSync({ entryPoints: [join(root, 'src/server/clinical-core', entry)], outfile,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent' });
const { createRdsDataClinicalCoreDatabase } = projectRequire(adapterBundle);
const { RUNTIME_CREDENTIAL_ADMISSION_SQL, runtimeCredentialAdmitted } = projectRequire(metadataBundle);
const credentialBundleSha256 = sha(readFileSync(adapterBundle));
const credentialMetadataSha256 = sha(readFileSync(metadataBundle));
const data = join(directory, 'cluster'), passwordFile = join(directory, 'bootstrap-password');
const password = randomBytes(32).toString('hex'), ownerPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex'), runtimeLogin = 'alp_api_qualification_native';
const database = 'alp_owner_source_' + randomUUID().replaceAll('-', '');
writeFileSync(passwordFile, password + '\n', { flag: 'wx', mode: 0o600 });
let started = false, admin, compiler, blocker, actor, peer, revoker, configuration, report, artifact, stage = 'bootstrap';
const results = [];
const credentialEvidence = []; let credentialAdmissions = 0;
const transferSql = 'select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result';
const dataResponse = result => ({columnMetadata:result.fields.map(f=>({name:f.name})),
  records:result.rows.map(row=>result.fields.map(f=>typeof row[f.name]==='boolean'
    ?{booleanValue:row[f.name]}:{stringValue:String(row[f.name])}))});
async function beginApi(connection, isolation = 'read committed') {
  await connection.query('begin isolation level ' + isolation);
  const metadata = await connection.query(RUNTIME_CREDENTIAL_ADMISSION_SQL, ['clinical_core_api']);
  if (!runtimeCredentialAdmitted(dataResponse(metadata))) {
    await connection.query('rollback'); refuse('native_runtime_credential_refused');
  }
  credentialAdmissions++;
  await connection.query('set local role clinical_core_api');
}
async function sourceFactoryHandshake(connection, expected, label, loginName) {
  const commands = []; let callbackCalls = 0, admitted = false;
  const common = {clusterArn:'arn:aws:rds:us-east-2:123456789012:cluster:fictional-native',
    secretArn:'arn:aws:secretsmanager:us-east-2:123456789012:secret:fictional-native-AbCd12',databaseName:database};
  const transport = {async send(command) {
    const name = command.constructor.name.replace(/\d+$/, ''); commands.push(name);
    if (name==='BeginTransactionCommand') {await connection.query('begin');return {transactionId:'fictional-native'};}
    if (name==='CommitTransactionCommand') {await connection.query('commit');return {};}
    if (name==='RollbackTransactionCommand') {await connection.query('rollback');return {};}
    if (name!=='ExecuteStatementCommand') refuse('native_adapter_command_refused');
    const sql = command.input.sql.replace(/:p(\d+)\b/g, (_match,n)=>'$'+n);
    const values = (command.input.parameters??[]).map(p=>p.value.stringValue);
    if (sql!==RUNTIME_CREDENTIAL_ADMISSION_SQL && sql!=='set local role clinical_core_api'
      && sql!=='select session_user as login_role,current_user as effective_role') refuse('native_adapter_sql_refused');
    return dataResponse(await connection.query(sql,values));
  }};
  try {
    await createRdsDataClinicalCoreDatabase(common,transport).transaction(async tx=>{
      callbackCalls++;
      const identity=(await tx.query('select session_user as login_role,current_user as effective_role')).rows[0];
      if(identity.login_role!==loginName||identity.effective_role!=='clinical_core_api') refuse('native_adapter_identity_refused');
    });
    admitted=true;
  } catch(error) {
    if(expected||error?.name!=='RdsDataDatabaseError'||error.category!=='configuration_invalid') refuse('native_adapter_unexpected_refusal');
  }
  const passed=admitted===expected&&callbackCalls===(expected?1:0)
    &&commands.at(-1)===(expected?'CommitTransactionCommand':'RollbackTransactionCommand');
  credentialEvidence.push({id:label,actualSourceFactory:true,loginName,admitted,callbackCalls,transactionSettled:passed,passed});
  if(!passed)refuse('native_adapter_handshake_failed');
}
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
async function context(f, connection = actor, isolation = 'read committed') {
  if (!['read committed', 'repeatable read', 'serializable'].includes(isolation)) refuse('native_isolation_refused');
  await beginApi(connection, isolation);
  await connection.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')", [f.practitioner, f.org, 'subject-' + f.practitioner]);
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
  else if (action === 'identity') await admin.query("update clinical_core.identities set status='disabled' where person_id=$1", [f.practitioner]);
  else if (action === 'person') await admin.query("update clinical_core.persons set status='disabled' where id=$1", [f.practitioner]);
  else if (action === 'organization') await admin.query("update clinical_core.organizations set status='suspended' where id=$1", [f.org]);
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
    : /^(request_context_refused|clinical_role_required|clinical_patient_required|membership_required|patient_record_not_found|patient_not_found|telehealth_current_authority_refused)$/;
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
    : action === 'person' ? "update clinical_core.persons set status='disabled' where id=$1"
    : action === 'organization' ? "update clinical_core.organizations set status='suspended' where id=$1"
    : null;
  if (!changeSql) refuse('authority_change_refused');
  let changeOutcome;
  const pending = revoker.query(changeSql, [action === 'patient' ? f.patient : action === 'organization' ? f.org : f.practitioner])
    .then(() => (changeOutcome = { changed: true }), error => (changeOutcome = { changed: false, code: error.code }));
  let observedLock = null, serialized = false;
  for (let i = 0; i < 100; i++) {
    const row = (await admin.query('select wait_event_type,wait_event,pg_blocking_pids($1) pids from pg_stat_activity where pid=$1', [revokerPid])).rows[0];
    if (row?.wait_event_type === 'Lock') {
      observedLock = row.wait_event;
      serialized = observedLock === 'advisory' && row.pids.includes(pid);
      break;
    }
    if (changeOutcome) break;
    await delay(25);
  }
  const beforeCommit = await counts(f);
  // If the change already returned, actually commit it before the writer.
  // This records the incorrect ordering rather than masking it with rollback.
  const revokedBeforeWriterCommit = !!changeOutcome?.changed;
  if (revokedBeforeWriterCommit) await revoker.query('commit');
  await actor.query('commit');
  const change = await pending;
  if (!change.changed) refuse('authority_change_failed');
  if (!revokedBeforeWriterCommit) await revoker.query('commit');
  const afterCommit = await counts(f);
  let retry;
  try { await context(f); await actor.query(transferSql, signed.args); retry = { accepted: true }; }
  catch (error) { retry = { accepted: false, code: error.code, marker: error.message }; }
  await actor.query(retry.accepted ? 'commit' : 'rollback');
  const afterRetry = await counts(f);
  const allowed = /^(clinical_role_required|patient_not_found|request_context_refused|telehealth_current_authority_refused)$/;
  results.push({ id: action + '_revocation_waits_for_admitted_writer', observedLock, acceptedBeforeRevocation: true,
    serialized, revokedBeforeWriterCommit,
    retryAccepted: retry.accepted, retryRefusal: /^[a-z_]+$/.test(retry.marker ?? '') ? retry.marker : null,
    beforeCommit, afterCommit, passed: serialized && !revokedBeforeWriterCommit
      && beforeCommit.transfers === 0 && beforeCommit.notes === 0 && beforeCommit.encounters === 0
      && afterCommit.transfers === 1 && afterCommit.notes === 1 && afterCommit.encounters === 1
      && !retry.accepted && allowed.test(retry.marker ?? '') && canonical(afterCommit) === canonical(afterRetry) });
}

async function concurrentReplay() {
  const f = await fixture(), first = await admitted(f), second = await admitted(f);
  await context(f);
  const writerPid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  const written = (await actor.query(transferSql, first.args)).rows[0].result;
  await context(f, peer);
  const peerPid = (await peer.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending = peer.query(transferSql, second.args).then(value => ({ accepted: true, value: value.rows[0].result }),
    error => ({ accepted: false, code: error.code }));
  const observedLock = await waitForBlocked(peerPid);
  const blockedByWriter = (await admin.query('select pg_blocking_pids($1) pids', [peerPid])).rows[0].pids.includes(writerPid);
  await actor.query('commit');
  const repeated = await pending;
  await peer.query(repeated.accepted ? 'commit' : 'rollback');
  const after = await counts(f);
  results.push({ id: 'concurrent_replay_one_destination', observedLock, blockedByWriter, accepted: repeated.accepted,
    created: repeated.value?.created ?? null, after,
    passed: observedLock === 'advisory' && blockedByWriter && written.created === true && repeated.accepted
      && repeated.value.created === false && written.transfer_id === repeated.value.transfer_id
      && written.note_id === repeated.value.note_id && after.transfers === 1 && after.notes === 1 && after.encounters === 1 });
  await context(f);
  const replayed = (await actor.query(transferSql, first.args)).rows[0].result;
  await actor.query('commit');
  const afterReplay = await counts(f);
  results.push({ id: 'exact_replay_same_destination', created: replayed.created, after: afterReplay,
    passed: replayed.created === false && replayed.transfer_id === written.transfer_id && replayed.note_id === written.note_id
      && canonical(afterReplay) === canonical(after) });
}

async function snapshotIsolation(isolation, withdrawWhileBlocked) {
  const f = await fixture(), signed = await admitted(f);
  if (withdrawWhileBlocked) {
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('telehealth-transfer:'||$1::text,0))", [f.appointment]);
  }
  await context(f, actor, isolation);
  const actualIsolation = (await actor.query("select current_setting('transaction_isolation') isolation")).rows[0].isolation;
  const pid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  let observedLock = null, completed;
  const pending = actor.query(transferSql, signed.args).then(value => (completed = { accepted: true, value }),
    error => (completed = { accepted: false, code: error.code, marker: error.message }));
  if (withdrawWhileBlocked) {
    // Either observe the real serialization wait, or an immediate supported
    // refusal. Do not turn a setup error or timeout into a successful negative.
    for (let i = 0; i < 100 && !completed; i++) {
      const row = (await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [pid])).rows[0];
      if (row?.wait_event_type === 'Lock') { observedLock = row.wait_event; break; }
      await delay(25);
    }
    if (!completed && !observedLock) refuse('native_isolation_wait_unknown');
    await admin.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1", [f.practitioner]);
    await blocker.query('commit');
  }
  const outcome = await pending;
  // Persist an erroneously accepted result: the diagnostic must not conceal it.
  await actor.query(outcome.accepted ? 'commit' : 'rollback');
  const after = await counts(f);
  results.push({ id: isolation.replaceAll(' ', '_') + (withdrawWhileBlocked ? '_withdrawal_during_wait' : '_refused_before_transfer'),
    actualIsolation, observedLock, membershipWithdrawn: withdrawWhileBlocked, accepted: outcome.accepted,
    refusalCode: outcome.code ?? null,
    refusalMarker: /^[a-z_]+$/.test(outcome.marker ?? '') ? outcome.marker : null, after,
    passed: actualIsolation === isolation && !outcome.accepted
      && outcome.marker === 'telehealth_transaction_isolation_refused'
      && after.transfers === 0 && after.notes === 0 && after.encounters === 0 });
}

async function unrelatedClinicTransfers() {
  const first = await fixture(), second = await fixture();
  const firstAdmission = await admitted(first), secondAdmission = await admitted(second);
  await context(first); await actor.query(transferSql, firstAdmission.args);
  await context(second, peer);
  const peerPid = (await peer.query('select pg_backend_pid() pid')).rows[0].pid;
  let settled, observedLock = null;
  const pending = peer.query(transferSql, secondAdmission.args).then(
    value => (settled = { accepted: true, value }), error => (settled = { accepted: false, code: error.code }));
  for (let i = 0; i < 100 && !settled; i++) {
    const row = (await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [peerPid])).rows[0];
    if (row?.wait_event_type === 'Lock') { observedLock = row.wait_event; break; }
    await delay(25);
  }
  const completedBeforeFirstCommit = settled?.accepted === true;
  const firstBeforeCommit = await counts(first), secondBeforeCommit = await counts(second);
  await actor.query('commit'); const outcome = await pending;
  await peer.query(outcome.accepted ? 'commit' : 'rollback');
  const firstAfter = await counts(first), secondAfter = await counts(second);
  results.push({ id: 'unrelated_clinic_transfers_share_fence', completedBeforeFirstCommit, observedLock,
    firstBeforeCommit, secondBeforeCommit, firstAfter, secondAfter,
    passed: completedBeforeFirstCommit && observedLock === null
      && Object.values(firstBeforeCommit).every(n => n === 0) && Object.values(secondBeforeCommit).every(n => n === 0)
      && Object.values(firstAfter).every(n => n === 1) && Object.values(secondAfter).every(n => n === 1) });
}

async function ordinaryPatientUpdate() {
  const first = await fixture(), second = await fixture(), admission = await admitted(first);
  await context(first); await actor.query(transferSql, admission.args);
  await revoker.query('begin');
  const pid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
  let settled, observedLock = null;
  const pending = revoker.query("update clinical_core.patient_records set first_name='FICTIONAL UPDATED' where id=$1", [second.patient])
    .then(value => (settled = { changed: value.rowCount === 1 }), error => (settled = { changed: false, code: error.code }));
  for (let i = 0; i < 100 && !settled; i++) {
    const row = (await admin.query('select wait_event_type,wait_event from pg_stat_activity where pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock') { observedLock = row.wait_event; break; }
    await delay(25);
  }
  const completedBeforeFirstCommit = settled?.changed === true;
  await actor.query('commit'); const outcome = await pending;
  await revoker.query(outcome.changed ? 'commit' : 'rollback');
  const changed = (await admin.query("select first_name='FICTIONAL UPDATED' changed from clinical_core.patient_records where id=$1", [second.patient])).rows[0].changed;
  results.push({ id: 'ordinary_patient_update_does_not_take_authority_fence', completedBeforeFirstCommit, observedLock,
    changed, passed: completedBeforeFirstCommit && observedLock === null && changed === true });
}

async function queuedOtherClinicWithdrawal() {
  const first = await fixture(), second = await fixture();
  const firstAdmission = await admitted(first), secondAdmission = await admitted(second);
  await context(first); const writerPid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  await actor.query(transferSql, firstAdmission.args);
  await revoker.query('begin'); const revokerPid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
  const withdrawal = revoker.query("update clinical_core.organizations set status='suspended' where id=$1", [second.org])
    .then(() => ({ changed: true }), error => ({ changed: false, code: error.code }));
  const withdrawalLock = await waitForBlocked(revokerPid);
  const withdrawalBlockedByWriter = (await admin.query('select pg_blocking_pids($1) pids', [revokerPid])).rows[0].pids.includes(writerPid);
  await context(second, peer); const peerPid = (await peer.query('select pg_backend_pid() pid')).rows[0].pid;
  const transfer = peer.query(transferSql, secondAdmission.args).then(() => ({ accepted: true }),
    error => ({ accepted: false, code: error.code, marker: error.message }));
  const transferLock = await waitForBlocked(peerPid);
  const transferBlockedByWithdrawal = (await admin.query('select pg_blocking_pids($1) pids', [peerPid])).rows[0].pids.includes(revokerPid);
  await actor.query('commit'); const changed = await withdrawal;
  await revoker.query(changed.changed ? 'commit' : 'rollback');
  const outcome = await transfer; await peer.query(outcome.accepted ? 'commit' : 'rollback');
  const after = await counts(second);
  results.push({ id: 'queued_other_clinic_withdrawal_refuses_later_transfer', withdrawalLock, transferLock,
    withdrawalBlockedByWriter, transferBlockedByWithdrawal, withdrawalCommitted: changed.changed,
    accepted: outcome.accepted, refusalCode: outcome.code ?? null,
    refusalMarker: /^[a-z_]+$/.test(outcome.marker ?? '') ? outcome.marker : null, after,
    passed: withdrawalLock === 'advisory' && transferLock === 'advisory'
      && withdrawalBlockedByWriter && transferBlockedByWithdrawal && changed.changed && !outcome.accepted
      && /^(clinical_role_required|request_context_refused|telehealth_current_authority_refused)$/.test(outcome.marker ?? '')
      && Object.values(after).every(n => n === 0) });
}

async function mixedLockOrderRecovery(expectedVictim) {
  if (!['revoker', 'actor'].includes(expectedVictim)) refuse('deadlock_control_refused');
  const first = await fixture(), second = { ...first, patient: randomUUID(), appointment: randomUUID() };
  await admin.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','SIBLING CHART')",
    [second.patient, second.org, 'patient_' + second.patient.replaceAll('-', '')]);
  await admin.query("insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,status,starts_at,ends_at,created_by_person_id,updated_by_person_id) values($1,$2,$3,$4,'telehealth','completed','2026-10-09T17:00:00Z','2026-10-09T17:30:00Z',$4,$4)",
    [second.appointment, second.org, second.patient, second.practitioner]);
  const firstAdmission = await admitted(first), secondAdmission = await admitted(second);
  await context(first); const writerPid = (await actor.query('select pg_backend_pid() pid')).rows[0].pid;
  await actor.query(transferSql, firstAdmission.args);
  // Deliberately inverted external writer order is a negative control, not a
  // claim that a normal application workflow uses this bootstrap-only path.
  await revoker.query('begin');
  // Only this bootstrap fixture connection can set this superuser GUC. The
  // API session inherits the local server's five-second default unchanged.
  // Choose which real PostgreSQL detector reaches the cycle first; no error
  // injection, role grant, retry or production setting change is involved.
  await revoker.query(expectedVictim === 'revoker' ? "set local deadlock_timeout='1s'" : "set local deadlock_timeout='10s'");
  await revoker.query('select id from clinical_core.patient_records where id=$1 for update', [second.patient]);
  const revokerPid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
  const withdrawal = revoker.query('update clinical_core.patient_records set deleted_at=clock_timestamp() where id=$1', [second.patient])
    .then(() => ({ participant: 'revoker', accepted: true }), error => ({ participant: 'revoker', accepted: false, code: error.code }));
  const withdrawalLock = await waitForBlocked(revokerPid);
  const withdrawalBlockedByWriter = (await admin.query('select pg_blocking_pids($1) pids', [revokerPid])).rows[0].pids.includes(writerPid);
  const transfer = actor.query(transferSql, secondAdmission.args)
    .then(() => ({ participant: 'actor', accepted: true }), error => ({ participant: 'actor', accepted: false, code: error.code }));
  const transferLock = await waitForBlocked(writerPid);
  const transferBlockedByWithdrawal = (await admin.query('select pg_blocking_pids($1) pids', [writerPid])).rows[0].pids.includes(revokerPid);
  const firstOutcome = await Promise.race([withdrawal, transfer]);
  let writerOutcome, withdrawalOutcome;
  if (firstOutcome.participant === 'actor') {
    writerOutcome = firstOutcome; await actor.query(writerOutcome.accepted ? 'commit' : 'rollback');
    withdrawalOutcome = await withdrawal; await revoker.query(withdrawalOutcome.accepted ? 'commit' : 'rollback');
  } else {
    withdrawalOutcome = firstOutcome; await revoker.query(withdrawalOutcome.accepted ? 'commit' : 'rollback');
    writerOutcome = await transfer; await actor.query(writerOutcome.accepted ? 'commit' : 'rollback');
  }
  const firstAfter = await counts(first), secondAfter = await counts(second);
  const withdrawn = (await admin.query('select deleted_at is not null withdrawn from clinical_core.patient_records where id=$1', [second.patient])).rows[0].withdrawn;
  const writerCommitted = writerOutcome.accepted && !withdrawalOutcome.accepted && withdrawalOutcome.code === '40P01' && !withdrawn
    && Object.values(firstAfter).every(n => n === 1) && Object.values(secondAfter).every(n => n === 1);
  const withdrawalCommitted = !writerOutcome.accepted && writerOutcome.code === '40P01' && withdrawalOutcome.accepted && withdrawn
    && Object.values(firstAfter).every(n => n === 0) && Object.values(secondAfter).every(n => n === 0);
  await context(second);
  const replay = await actor.query(transferSql, secondAdmission.args)
    .then(value => ({ accepted: true, created: value.rows[0].result.created }), error => ({ accepted: false, code: error.code, marker: error.message }));
  await actor.query(replay.accepted ? 'commit' : 'rollback');
  const replayPreservedCounts = canonical(firstAfter) === canonical(await counts(first))
    && canonical(secondAfter) === canonical(await counts(second));
  const replayCorrect = writerCommitted ? replay.accepted && replay.created === false
    : withdrawalCommitted && !replay.accepted && /^(patient_not_found|clinical_patient_required|telehealth_current_authority_refused)$/.test(replay.marker ?? '');
  results.push({ id: 'mixed_lock_order_' + expectedVictim + '_deadlock_rolls_back_atomically', execution: 'deliberately_inverted_external_lock_order',
    expectedVictim, observedVictim: firstOutcome.participant,
    withdrawalLock, transferLock, withdrawalBlockedByWriter, transferBlockedByWithdrawal,
    writerAccepted: writerOutcome.accepted, writerCode: writerOutcome.code ?? null,
    withdrawalAccepted: withdrawalOutcome.accepted, withdrawalCode: withdrawalOutcome.code ?? null,
    withdrawn, firstAfter, secondAfter, settledReplayAccepted: replay.accepted, settledReplayCreated: replay.created ?? null,
    settledReplayCode: replay.code ?? null, settledReplayMarker: /^[a-z_]+$/.test(replay.marker ?? '') ? replay.marker : null,
    replayPreservedCounts,
    passed: withdrawalLock === 'advisory' && transferBlockedByWithdrawal && withdrawalBlockedByWriter
      && firstOutcome.participant === expectedVictim && !firstOutcome.accepted && firstOutcome.code === '40P01'
      && (writerCommitted || withdrawalCommitted) && replayCorrect && replayPreservedCounts });
}

try {
  run('initdb', ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--data-checksums']);
  unlinkSync(passwordFile);
  const socket = createServer(); await new Promise((ok, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', ok); });
  const port = socket.address().port; await new Promise((ok, no) => socket.close(error => error ? no(error) : ok()));
  started = true;
  run('pg_ctl', ['-D', data, '-l', join(directory, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -c max_connections=10 -c shared_buffers=32MB -c timezone=UTC -c deadlock_timeout=5s`, '-w', '-t', '30', 'start']);
  configuration = { host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', ssl: false, connectionTimeoutMillis: 5000,
    query_timeout: 30000, application_name: 'alp-fictional-native-lock-tests', options: '-c statement_timeout=30000 -c search_path=pg_catalog,public' };
  admin = new Client(configuration); await admin.connect();
  await admin.query(`create role clinical_admin login nosuperuser inherit createdb createrole noreplication nobypassrls password '${ownerPassword}'`);
  await admin.query('create database "' + database + '" owner clinical_admin'); await admin.end();
  configuration.database = database;
  const ownerConfiguration = { ...configuration, user: 'clinical_admin', password: ownerPassword };
  compiler = new Client(ownerConfiguration); await compiler.connect(); await compiler.query('create extension pgcrypto with schema public');
  const db = { query: (sql, args = []) => compiler.query(sql, [...args]), exec: sql => compiler.query(sql), transaction: async work => {
    await compiler.query('begin'); try { const value = await work(db); await compiler.query('commit'); return value; } catch (e) { await compiler.query('rollback'); throw e; } } };
  artifact = (JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })));
  if (artifact.candidate.contract !== 'telehealth-transfer-authority-candidate/4' || artifact.candidate.migrationCount !== 117
    || artifact.candidate.extensionSha256 !== TELEHEALTH_AUTHORITY_SQL_SHA256
    || artifact.candidate.activation !== 'blocked' || artifact.candidate.phiAllowed !== false) refuse('successor_artifact_refused');
  stage = 'source_compilation';
  const compiled = await compileTelehealthAuthorityRestrictedOwnerSource(db);
  if (compiled.postgresVersion !== '17.7' || compiled.snapshots.map(s => s.migrationCount).join(',') !== '112,113,114,115,116,117') refuse('source_compile_refused');
  const last = compiled.snapshots.at(-1);
  if (last.migrationCount !== artifact.candidate.migrationCount || last.migrationReleaseSha256 !== artifact.candidate.migrationReleaseSha256
    || last.assemblySha256 !== artifact.releaseHash) refuse('source_compile_refused');
  await compiler.end(); compiler = undefined;
  // The schema owner compiles only. Request connections authenticate as their
  // own restricted NOINHERIT login, never as the owner with a lowered role.
  admin = new Client(configuration); blocker = new Client(configuration); revoker = new Client(configuration);
  await admin.connect(); await blocker.connect(); await revoker.connect();
  await admin.query(`create role ${runtimeLogin} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${runtimePassword}';
    grant clinical_core_api to ${runtimeLogin} with inherit false,set true`);
  const runtimeConfiguration = {...configuration,user:runtimeLogin,password:runtimePassword};
  actor = new Client(runtimeConfiguration);
  peer = new Client(runtimeConfiguration);
  await actor.connect(); await peer.connect();
  stage = 'actual_factory_credential_admission';
  await sourceFactoryHandshake(actor,true,'actor_runtime_admitted',runtimeLogin);
  await sourceFactoryHandshake(peer,true,'peer_runtime_admitted',runtimeLogin);
  compiler = new Client(ownerConfiguration); await compiler.connect();
  await sourceFactoryHandshake(compiler,false,'schema_owner_credential_refused','clinical_admin');
  await compiler.end(); compiler=undefined;
  await actor.query('begin'); let elevatedCode=null;
  try {await actor.query('set local role clinical_admin');} catch(error) {elevatedCode=error.code;}
  await actor.query('rollback');
  credentialEvidence.push({id:'runtime_admin_role_denied',loginName:runtimeLogin,refusalCode:elevatedCode,passed:elevatedCode==='42501'});
  if(elevatedCode!=='42501')refuse('native_admin_role_return_allowed');
  stage = 'private_api_denials';
  for (const table of ['clinical_private.telehealth_admission_keys', 'clinical_core.telehealth_note_transfers']) {
    await beginApi(actor);
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
  await scenario('identity_disabled_during_destination_row_lock', 'identity', true);
  await scenario('person_disabled_during_destination_row_lock', 'person', true);
  await scenario('organization_suspended_during_destination_row_lock', 'organization', true);
  await admittedBeforeRevocation('membership');
  await admittedBeforeRevocation('patient');
  await admittedBeforeRevocation('identity');
  await admittedBeforeRevocation('person');
  await admittedBeforeRevocation('organization');
  await concurrentReplay();
  stage = 'snapshot_isolation';
  await snapshotIsolation('repeatable read', false);
  await snapshotIsolation('serializable', false);
  await snapshotIsolation('repeatable read', true);
  await snapshotIsolation('serializable', true);
  stage = 'multi_clinic_fence';
  await unrelatedClinicTransfers();
  await ordinaryPatientUpdate();
  await queuedOtherClinicWithdrawal();
  await mixedLockOrderRecovery('revoker');
  await mixedLockOrderRecovery('actor');
  const credentialComplete=credentialEvidence.length===4&&credentialEvidence.every(row => row.passed === true)&&credentialAdmissions>0;
  report = { contract: 'telehealth-authority-native-source/4', sourceCommit, diagnosticSha256: sha(readFileSync(new URL(import.meta.url))),
    testedArtifact: { contract: artifact.candidate.contract, migrationCount: artifact.candidate.migrationCount,
      migrationReleaseSha256: artifact.candidate.migrationReleaseSha256, assemblySha256: artifact.releaseHash },
    execution: 'local_restricted_owner_source', postgresVersion: '17.7',
    sourceBootstrapOwner: 'postgres', sourceOwner: 'clinical_admin',
    apiSessionOwner:runtimeLogin, apiCallerRole: 'clinical_core_api',
    credentialBundleSha256,credentialMetadataSha256,credentialEvidence,credentialAdmissions,
    credentialBoundaryVerified:credentialComplete,authorityTransactions:'native_sql_with_source_credential_admission',
    managedRoleSemanticsVerified: false, hostedVerified: false, upgradeAuthorized: false, providerAuthorized: false, phiAllowed: false, activation: 'blocked',
    mandatoryScenarioCount: REQUIRED_NATIVE_AUTHORITY_SCENARIOS.length,
    coverageComplete: completeNativeAuthorityCoverage(results),
    passed: completeNativeAuthorityCoverage(results)&&credentialComplete, results };
} catch (error) {
  report = { contract: 'telehealth-authority-native-source/4', sourceCommit,
    execution: 'local_restricted_owner_source', managedRoleSemanticsVerified: false, hostedVerified: false,
    mandatoryScenarioCount: REQUIRED_NATIVE_AUTHORITY_SCENARIOS.length, coverageComplete: false,
    ...(artifact ? { testedArtifact: { contract: artifact.candidate.contract, migrationCount: artifact.candidate.migrationCount,
      migrationReleaseSha256: artifact.candidate.migrationReleaseSha256, assemblySha256: artifact.releaseHash } } : {}), passed: false, stage,
    databaseErrorCode: /^[A-Z0-9]{5}$/.test(error?.code ?? '') ? error.code : null,
    failure: /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'native_source_run_failed', results,
    credentialBundleSha256,credentialMetadataSha256,credentialEvidence,credentialAdmissions,credentialBoundaryVerified:false,
    phiAllowed: false, activation: 'blocked', upgradeAuthorized: false, providerAuthorized: false };
} finally {
  for (const connection of [actor, peer, blocker, revoker, compiler, admin]) if (connection) await connection.end().catch(() => {});
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
