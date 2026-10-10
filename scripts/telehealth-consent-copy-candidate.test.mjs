import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { telehealthConsentCopyCandidate } from './telehealth-consent-copy-candidate.mjs';
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-fullscript-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true }));
const sql = readFileSync('infra/aws-clinical-core/production-candidates/telehealth-consent-copy.sql', 'utf8').replace(/\r\n?/g, '\n');
test('copies all parent bytes without widening historical scope or activation', () => {
  const a = telehealthConsentCopyCandidate(parent, sql);
  assert.equal(a.manifest.migrations.length, 112);
  assert.deepEqual(a.manifest.migrations.slice(0, 111), parent.manifest.migrations);
  for (const m of parent.manifest.migrations) assert.equal(a.files[m.file], parent.files[m.file]);
  assert.equal(a.candidate.phiAllowed, false); assert.equal(a.candidate.activation, 'blocked');
  assert.equal(a.candidate.deployment, 'not_deployed'); assert.equal(a.candidate.seededApprovals, false);
  assert.deepEqual(telehealthConsentCopyCandidate(parent, sql.replaceAll('\n', '\r\n')), a);
});
for (const [name, mutate] of [
  ['missing activation', p => { delete p.candidate.activation; }],
  ['missing PHI flag', p => { delete p.candidate.phiAllowed; }],
  ['approved activation', p => { p.candidate.activation = 'approved'; }],
  ['enabled PHI', p => { p.candidate.phiAllowed = true; }],
  ['wrong candidate count', p => { p.candidate.migrationCount = 112; }],
  ['wrong ledger claim', p => { p.candidate.migrationReleaseSha256 = 'a'.repeat(64); }],
  ['extra file', p => { p.files['unlisted.sql'] = 'select 1;'; }],
  ['missing SQL', p => { delete p.files[p.manifest.migrations[0].file]; }],
  ['changed parent SQL', p => { p.files[p.manifest.migrations[0].file] += '\nselect 1;'; }],
  ['changed parent file name', p => { p.manifest.migrations[0].file = '20260101000000_forged.sql'; }],
  ['duplicate version', p => { p.manifest.migrations[1].version = p.manifest.migrations[0].version; }],
  ['wrong source assembly', p => { p.releaseHash = 'b'.repeat(64); }],
  ['parent newline drift', p => { const m = p.manifest.migrations[0]; p.files[m.file] = p.files[m.file].replaceAll('\n', '\r\n'); }],
]) test('refuses ' + name, () => {
  const changed = structuredClone(parent); mutate(changed);
  assert.throws(() => telehealthConsentCopyCandidate(changed, sql), /telehealth_consent_copy_artifact_refused/);
});
test('refuses changed extension even when parent and posture are correct', () => {
  assert.throws(() => telehealthConsentCopyCandidate(parent, sql + '\nselect 1;'), /artifact_refused/);
  assert.throws(() => telehealthConsentCopyCandidate(parent, null), /artifact_refused/);
});
