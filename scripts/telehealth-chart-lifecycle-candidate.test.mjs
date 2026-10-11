import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { telehealthChartLifecycleCandidate, TELEHEALTH_CHART_LIFECYCLE_FILE } from './telehealth-chart-lifecycle-candidate.mjs';
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const sql = readFileSync('infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql', 'utf8').replace(/\r\n?/g, '\n');
test('copies all 112 parent bytes unchanged and appends exactly one blocked forward migration', () => {
  const a = telehealthChartLifecycleCandidate(parent, sql);
  assert.equal(a.manifest.migrations.length, 113);
  assert.deepEqual(a.manifest.migrations.slice(0, 112), parent.manifest.migrations);
  assert.equal(a.manifest.migrations[112].file, TELEHEALTH_CHART_LIFECYCLE_FILE);
  for (const m of parent.manifest.migrations) assert.equal(a.files[m.file], parent.files[m.file]);
  assert.equal(a.candidate.phiAllowed, false); assert.equal(a.candidate.activation, 'blocked');
  assert.equal(a.candidate.deployment, 'not_deployed'); assert.equal(a.candidate.seededApprovals, false);
  assert.equal(a.candidate.seededTransfers, false);
  assert.equal(a.candidate.seededAdmissionKeys, false);
  assert.equal(a.candidate.contract, 'telehealth-chart-lifecycle-candidate/4');
  assert.equal(TELEHEALTH_CHART_LIFECYCLE_FILE, '20261010190000_production_telehealth_chart_lifecycle.sql');
  assert.equal(a.candidate.parentMigrationReleaseSha256, parent.candidate.migrationReleaseSha256);
  assert.deepEqual(telehealthChartLifecycleCandidate(parent, sql.replaceAll('\n', '\r\n')), a);
});
for (const [name, mutate] of [
  ['missing activation', p => { delete p.candidate.activation; }],
  ['approved activation', p => { p.candidate.activation = 'approved'; }],
  ['enabled PHI', p => { p.candidate.phiAllowed = true; }],
  ['deployed parent', p => { p.candidate.deployment = 'deployed'; }],
  ['seeded consents', p => { p.candidate.seededConsents = true; }],
  ['wrong parent contract', p => { p.candidate.contract = 'fullscript-candidate/1'; }],
  ['wrong candidate count', p => { p.candidate.migrationCount = 113; }],
  ['wrong ledger claim', p => { p.candidate.migrationReleaseSha256 = 'a'.repeat(64); }],
  ['extra file', p => { p.files['unlisted.sql'] = 'select 1;'; }],
  ['missing SQL', p => { delete p.files[p.manifest.migrations[0].file]; }],
  ['changed parent SQL', p => { p.files[p.manifest.migrations[0].file] += '\nselect 1;'; }],
  ['changed 112 extension', p => { const m = p.manifest.migrations[111]; p.files[m.file] += '\n-- drift'; }],
  ['dropped parent migration', p => { const m = p.manifest.migrations.pop(); delete p.files[m.file]; }],
  ['duplicate version', p => { p.manifest.migrations[1].version = p.manifest.migrations[0].version; }],
  ['wrong source assembly', p => { p.releaseHash = 'b'.repeat(64); }],
  ['parent newline drift', p => { const m = p.manifest.migrations[0]; p.files[m.file] = p.files[m.file].replaceAll('\n', '\r\n'); }],
]) test('refuses ' + name, () => {
  const changed = structuredClone(parent); mutate(changed);
  assert.throws(() => telehealthChartLifecycleCandidate(changed, sql), /telehealth_chart_lifecycle_artifact_refused/);
});
test('refuses a changed extension even when the parent and posture are exact', () => {
  assert.throws(() => telehealthChartLifecycleCandidate(parent, sql + '\nselect 1;'), /artifact_refused/);
  assert.throws(() => telehealthChartLifecycleCandidate(parent, sql.replace('telehealth.note_transferred', 'telehealth.note_signed')), /artifact_refused/);
  assert.throws(() => telehealthChartLifecycleCandidate(parent, null), /artifact_refused/);
  assert.throws(() => telehealthChartLifecycleCandidate(parent, sql.replace('_now := clock_timestamp();', '_now := transaction_timestamp();')), /artifact_refused/);
});
