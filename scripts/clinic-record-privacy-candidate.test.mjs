import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { clinicRecordPrivacyCandidate, CLINIC_RECORD_PRIVACY_FILE } from './clinic-record-privacy-candidate.mjs';
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-key-fence-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const sql = readFileSync('infra/aws-clinical-core/production-candidates/clinic-record-privacy.sql', 'utf8').replace(/\r\n?/g, '\n');
test('copies all 115 parent bytes unchanged and appends exactly one blocked forward migration', () => {
  const a = clinicRecordPrivacyCandidate(parent, sql);
  assert.equal(a.manifest.migrations.length, 116);
  assert.deepEqual(a.manifest.migrations.slice(0, 115), parent.manifest.migrations);
  assert.equal(a.manifest.migrations[115].file, CLINIC_RECORD_PRIVACY_FILE);
  for (const m of parent.manifest.migrations) assert.equal(a.files[m.file], parent.files[m.file]);
  assert.equal(a.candidate.phiAllowed, false); assert.equal(a.candidate.activation, 'blocked');
  assert.equal(a.candidate.deployment, 'not_deployed'); assert.equal(a.candidate.seededApprovals, false);
  assert.equal(a.candidate.seededDisclosureReleases, false); assert.equal(a.candidate.seededRequests, false);
  assert.equal(a.candidate.parentMigrationReleaseSha256, parent.candidate.migrationReleaseSha256);
  assert.deepEqual(clinicRecordPrivacyCandidate(parent, sql.replaceAll('\n', '\r\n')), a);
});
for (const [name, mutate] of [
  ['missing activation', p => { delete p.candidate.activation; }],
  ['approved activation', p => { p.candidate.activation = 'approved'; }],
  ['enabled PHI', p => { p.candidate.phiAllowed = true; }],
  ['deployed parent', p => { p.candidate.deployment = 'deployed'; }],
  ['seeded admission keys', p => { p.candidate.seededAdmissionKeys = true; }],
  ['seeded transfers', p => { p.candidate.seededTransfers = true; }],
  ['wrong parent contract', p => { p.candidate.contract = 'telehealth-chart-lifecycle-candidate/2'; }],
  ['wrong candidate count', p => { p.candidate.migrationCount = 116; }],
  ['wrong ledger claim', p => { p.candidate.migrationReleaseSha256 = 'a'.repeat(64); }],
  ['extra file', p => { p.files['unlisted.sql'] = 'select 1;'; }],
  ['missing SQL', p => { delete p.files[p.manifest.migrations[0].file]; }],
  ['changed parent SQL', p => { p.files[p.manifest.migrations[0].file] += '\nselect 1;'; }],
  ['changed lifecycle/4 extension', p => { const m = p.manifest.migrations[112]; p.files[m.file] += '\n-- drift'; }],
  ['changed host/1 extension', p => { const m = p.manifest.migrations[113]; p.files[m.file] += '\n-- drift'; }],
  ['changed key-fence/1 extension', p => { const m = p.manifest.migrations[114]; p.files[m.file] += '\n-- drift'; }],
  ['extra parent permission claim', p => { p.candidate.providerAuthorized = true; }],
  ['wrong parent assembly claim', p => { p.candidate.parentArtifactSha256 = 'b'.repeat(64); }],
  ['dropped parent migration', p => { const m = p.manifest.migrations.pop(); delete p.files[m.file]; }],
  ['duplicate version', p => { p.manifest.migrations[1].version = p.manifest.migrations[0].version; }],
  ['wrong source assembly', p => { p.releaseHash = 'b'.repeat(64); }],
  ['parent newline drift', p => { const m = p.manifest.migrations[0]; p.files[m.file] = p.files[m.file].replaceAll('\n', '\r\n'); }],
]) test('refuses ' + name, () => {
  const changed = structuredClone(parent); mutate(changed);
  assert.throws(() => clinicRecordPrivacyCandidate(changed, sql), /clinic_record_privacy_artifact_refused/);
});
test('refuses a changed extension even when the parent and posture are exact', () => {
  assert.throws(() => clinicRecordPrivacyCandidate(parent, sql + '\nselect 1;'), /artifact_refused/);
  assert.throws(() => clinicRecordPrivacyCandidate(parent, sql.replace('clinic_disclosure_release_required', 'clinic_disclosure_release_optional')), /artifact_refused/);
  assert.throws(() => clinicRecordPrivacyCandidate(parent, null), /artifact_refused/);
});
