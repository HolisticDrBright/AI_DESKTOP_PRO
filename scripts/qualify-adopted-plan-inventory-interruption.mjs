/** Authorized fictional qualification only. No target, credential or custody-root override. */
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [mode, confirmation, ...extra] = process.argv.slice(2);
if (extra.length || !['before-write', 'precommit', 'reconcile-only'].includes(mode)
  || confirmation !== '--confirm-fictional-inventory-interruption') throw new Error('interruption_argument_refused');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = 'C:/Users/Brand/Documents/Codex/2026-08-18/referenced-chatgpt-conversation-this-is-an/work/DESKTOP_COMMERCIAL_20261005/dist/synthetic-care-routing';
const directory = resolve('dist/aws-clinical-core/adopted-plan-inventory-upgrade');
const worker = resolve(directory, 'interruption-worker.cjs');
const manifest = JSON.parse(readFileSync(resolve(directory, 'artifact-manifest.json'), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'scripts', 'infra',
  'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
if (manifest.contract !== 'adopted-plan-inventory-upgrade-build/1' || manifest.sourceCommit !== head || manifest.clean !== true || dirty
  || manifest.phiAllowed !== false || manifest.activation !== 'blocked' || manifest.embeddedMigrationCount !== 107
  || manifest.interruptionWorkerScope !== 'instrumented_real_core_and_ports_before_write_and_precommit_only'
  || sha(readFileSync(worker)) !== manifest.interruptionWorkerSha256
  || sha(readFileSync(resolve(directory, 'index.cjs'))) !== manifest.operatorSha256) throw new Error('interruption_artifact_refused');
const lock = resolve(root, 'operator.lock');
const guard = resolve(root, 'inventory-upgrade-reconciliation.lock');
if (mode !== 'reconcile-only' && (existsSync(lock) || existsSync(guard))) throw new Error('interruption_existing_custody_refused');

function launch(command) {
  const child = fork(worker, [command, '--confirm-fictional-inventory-interruption'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], windowsHide: true,
  });
  const messages = []; let byteCount = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    byteCount += bytes.length;
    // Never print child output (including SDK diagnostics). Unexpected output
    // is recorded as a refusal after the exact child exits; no blind restart.
  });
  const first = new Promise((resolveFirst, rejectFirst) => {
    child.once('message', message => resolveFirst(message));
    child.once('error', () => rejectFirst(new Error('interruption_child_start_refused')));
    child.once('exit', () => { if (!messages.length) rejectFirst(new Error('interruption_checkpoint_missing')); });
  });
  child.on('message', message => messages.push(message));
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  return { child, first, exited, messages, outputBytes: () => byteCount };
}
function check(value, stage) { if (!value) throw new Error(`interruption_qualification_refused:${stage}`); }
async function expectRefusal(stage) {
  const attempt = launch('reconcile'), packet = await attempt.first, exit = await attempt.exited;
  check(packet?.kind === 'refused' && ['custody_refused', 'recovery_refused', 'boundary_refused'].includes(packet.category)
    && exit.code !== 0 && attempt.messages.length === 1 && attempt.outputBytes() === 0, stage);
  return { stage, refused: true, category: packet.category, detail: packet.stage ?? null };
}
async function reconcile() {
  const attempt = launch('reconcile'), packet = await attempt.first, exit = await attempt.exited;
  check(packet?.kind === 'result' && exit.code === 0 && attempt.messages.length === 1 && attempt.outputBytes() === 0, 'reconcile_result');
  const result = packet.result;
  check(result?.contract === 'adopted-plan-inventory-upgrade-reconciliation/1' && result.execution === 'qualification'
    && result.phiAllowed === false && result.activation === 'blocked' && result.custodySettled === true
    && result.originalWriteOutcome === 'unknown' && result.retryPerformed === false && result.databaseMutationPerformed === false
    && result.repeatedReadbackVerified === true && result.operatorSource?.sourceCommit === head && result.operatorSource?.clean === true
    && !existsSync(lock) && !existsSync(guard), 'reconcile_authority');
  return result;
}
if (mode === 'reconcile-only') {
  console.log(JSON.stringify({ contract: 'inventory-interruption-recovery/1', qualificationOnly: true, result: await reconcile() }));
} else {
  const writer = launch(mode), checkpoint = await writer.first;
  check(checkpoint?.kind === 'checkpoint' && checkpoint.mode === mode && checkpoint.execution === 'qualification'
    && checkpoint.phiAllowed === false && checkpoint.activation === 'blocked' && checkpoint.transactionCommitAdmitted === false
    && checkpoint.observedMigrationCount === (mode === 'before-write' ? 106 : 107)
    && Number.isSafeInteger(checkpoint.rowCount) && checkpoint.rowCount >= 0
    && /^[a-f0-9]{64}$/.test(checkpoint.dataSha256) && /^[a-f0-9]{64}$/.test(checkpoint.historicalSchemaSha256), 'checkpoint');
  const lockBytes = readFileSync(lock), header = JSON.parse(lockBytes.toString('utf8'));
  check(header.pid === writer.child.pid && header.build.sourceCommit === head
    && header.operatorSha256 === manifest.interruptionWorkerSha256 && header.configuration.qualificationDatabaseName === 'clinical_core_qualification', 'writer_binding');
  const journal = resolve(root, `${header.runId}.inventory.events.jsonl`), journalBytes = readFileSync(journal);
  const events = journalBytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  check(events.at(-1)?.stage === 'write_admitted', 'durable_admission');
  console.log(JSON.stringify({ stage: 'observed_actual_checkpoint', mode, runId: header.runId, transactionCommitAdmitted: false }));
  const liveRefusal = await expectRefusal('live_writer_refused');
  check(readFileSync(lock).equals(lockBytes) && readFileSync(journal).equals(journalBytes), 'live_custody_preserved');
  check(writer.child.exitCode === null && writer.child.signalCode === null && writer.child.kill(), 'exact_child_stop');
  const stopped = await writer.exited;
  check(stopped.code !== 0 && writer.messages.length === 1 && writer.outputBytes() === 0, 'writer_exit');
  const immediateRefusal = await expectRefusal('immediate_recovery_refused');
  check(readFileSync(lock).equals(lockBytes) && readFileSync(journal).equals(journalBytes), 'stopped_custody_preserved');
  console.log(JSON.stringify({ stage: 'waiting_for_server_transaction_settlement', mode, runId: header.runId }));
  // AWS documents a 3-minute idle transaction timeout. Time alone is NOT the
  // evidence: recovery must acquire the real fence and migration/table locks.
  await new Promise(resolveWait => setTimeout(resolveWait, 210_000));
  const result = await reconcile();
  check(result.observedMigrationCount === 106 && result.rowCount === checkpoint.rowCount && result.dataSha256 === checkpoint.dataSha256
    && result.historicalSchemaSha256 === checkpoint.historicalSchemaSha256 && result.runId === header.runId
    && readFileSync(journal).equals(journalBytes) && result.journalSha256 === sha(journalBytes), 'preserved_predecessor');
  console.log(JSON.stringify({ contract: 'adopted-inventory-interruption-qualification/1', mode, sourceCommit: head,
    workerSha256: manifest.interruptionWorkerSha256, sharedCustodyRoot: root, execution: 'qualification', verdict: 'passed',
    phiAllowed: false, activation: 'blocked', checkpoint, liveRefusal, immediateRefusal, originalLockSha256: sha(lockBytes), result,
    instrumentedCoreAndNativePorts: true, publicOperatorEndToEndQualified: false, postCommitReceiptLossQualified: false,
    diskPowerLossQualified: false, fullFleetAcceptance: false, productionActivationEvidence: false }));
}
