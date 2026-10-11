import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const script = new URL('./qualify-telehealth-authority-native.mjs', import.meta.url);
for (const [name, args] of [
  ['external database', ['--database-url', 'https://fictional.invalid']],
  ['reviewed target substitution', ['--target-manifest', 'qualification.json']],
  ['activation', ['--activation', 'approved']],
  ['source substitution', ['--source-commit', 'a'.repeat(40)]],
  ['relative binaries', ['--binary-directory', 'bin', '--driver-directory', 'driver']],
]) test('native runner refuses ' + name + ' before spawning a service', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(script), ...args],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(r.status, 1); assert.match(r.stderr, /telehealth_authority_native_arguments_refused/);
});
test('runner binds complete successor, restricted owner and real lock observations', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /112,113,114,115,116,117/);
  assert.match(source, /telehealth-transfer-authority-candidate\/4/);
  assert.match(source, /pg_blocking_pids/);
  assert.match(source, /waitForBlocked/);
  assert.match(source, /nosuperuser.*nobypassrls/);
  assert.match(source, /managedRoleSemanticsVerified: false/);
  assert.match(source, /apiCallerRole: 'clinical_core_api'/);
  assert.match(source, /shutdownConfirmed = true/);
  assert.doesNotMatch(source, /compileTelehealthSchemaNativeSource|local_bootstrap_owner_concurrency_control/);
  assert.match(source, /revokedBeforeWriterCommit/);
  assert.match(source, /snapshotIsolation\('repeatable read', true\)/);
  assert.match(source, /snapshotIsolation\('serializable', true\)/);
  assert.match(source, /outcome\.marker === 'telehealth_transaction_isolation_refused'/);
  assert.match(source, /await unrelatedClinicTransfers\(\)/);
  assert.match(source, /await ordinaryPatientUpdate\(\)/);
  assert.match(source, /await queuedOtherClinicWithdrawal\(\)/);
  assert.match(source, /await mixedLockOrderRecovery\('revoker'\)/);
  assert.match(source, /await mixedLockOrderRecovery\('actor'\)/);
  assert.match(source, /firstOutcome\.participant === expectedVictim/);
  assert.match(source, /replayPreservedCounts/);
  assert.match(source, /passed: completeNativeAuthorityCoverage\(results\)/);
  assert.match(source, /telehealth-authority-native-source\/3/);
});
