import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { telehealthTransferAuthorityCandidate, TELEHEALTH_AUTHORITY_FILE, TELEHEALTH_AUTHORITY_SQL_SHA256 } from './telehealth-transfer-authority-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const sql = readFileSync(new URL('../infra/aws-clinical-core/source-candidates/telehealth-transfer-authority.sql', import.meta.url), 'utf8');
test('exact 116 parent stays byte-identical in distinct blocked 117', () => {
  const a = telehealthTransferAuthorityCandidate(parent, sql);
  assert.equal(a.manifest.migrations.length, 117);
  assert.deepEqual(a.manifest.migrations.slice(0, 116), parent.manifest.migrations);
  for (const [file, bytes] of Object.entries(parent.files)) assert.equal(a.files[file], bytes);
  assert.equal(a.candidate.parentMigrationCount, 116);
  assert.equal(a.candidate.extensionSha256, TELEHEALTH_AUTHORITY_SQL_SHA256);
  assert.equal(a.manifest.migrations.at(-1).file, TELEHEALTH_AUTHORITY_FILE);
  assert.equal(a.candidate.activation, 'blocked'); assert.equal(a.candidate.phiAllowed, false);
  assert.equal(a.candidate.runtimeAdmission, false); assert.equal(a.candidate.managedRoleSemanticsVerified, false);
  assert.equal(a.candidate.seededApprovals, false); assert.equal(a.candidate.seededAdmissionKeys, false);
});
for (const [label, change] of [
  ['old count', p => p.manifest.migrations.pop()],
  ['changed parent SQL', p => p.files[p.manifest.migrations[0].file] += '\n'],
  ['wrong assembly', p => p.releaseHash = '0'.repeat(64)],
  ['production activation', p => p.candidate.activation = 'approved'],
  ['PHI enabled', p => p.candidate.phiAllowed = true],
  ['invented approval', p => p.candidate.reviewed = true],
  ['seeded authority', p => p.candidate.seededAdmissionKeys = true],
]) test('refuses ' + label, () => {
  const p = structuredClone(parent); change(p);
  assert.throws(() => telehealthTransferAuthorityCandidate(p, sql), /telehealth_authority_artifact_refused/);
});
test('source bytes cannot be substituted', () => {
  for (const s of [undefined, '', sql + '\n', sql.replace('for share', 'for key share')])
    assert.throws(() => telehealthTransferAuthorityCandidate(parent, s), /telehealth_authority_artifact_refused/);
});
test('documented source line endings yield exact LF output', () => {
  assert.deepEqual(telehealthTransferAuthorityCandidate(parent, sql.replace(/\n/g, '\r\n')), telehealthTransferAuthorityCandidate(parent, sql));
});
test('private owner policy is not an API grant or global RLS bypass', () => {
  assert.match(sql, /for select to clinical_core_migrator/);
  assert.match(sql, /current_user=pg_catalog\.pg_get_userbyid/);
  assert.doesNotMatch(sql, /grant\s|disable row level|no force row level|bypassrls/i);
  assert.match(sql, /after entry authorization/);
  assert.match(sql, /pg_advisory_xact_lock_shared/);
  assert.match(sql, /before update or delete on clinical_core\.organization_memberships/);
  assert.match(sql, /before update or delete on clinical_core\.patient_records/);
  assert.match(sql, /for update to clinical_core_migrator/);
});

test('fresh identity person and clinic authority is fenced without substituting retained claims', () => {
  assert.match(sql, /new\.production_bound,new\.status/);
  assert.match(sql, /before update or delete on clinical_core\.persons/);
  assert.match(sql, /before update or delete on clinical_core\.organizations/);
  assert.match(sql, /i\.identity_subject=clinical_private\.claim\('identity_subject'\)/);
  assert.match(sql, /i\.production_bound=true and i\.status='active'/);
  assert.match(sql, /p\.status='active'.*o\.status='active'/);
  assert.match(sql, /A replay reveals a destination receipt/);
  assert.equal((sql.match(/_actor := clinical_private\.require_current_telehealth_authority\(_organization_id,_patient_id\)/g) ?? []).length, 4);
});

test('snapshot isolation is refused before authority lookup or source admission', () => {
  const helper = sql.slice(sql.indexOf('create function clinical_private.require_current_telehealth_authority'),
    sql.indexOf('revoke all on function clinical_private.require_current_telehealth_authority'));
  assert.match(helper, /pg_catalog\.current_setting\('transaction_isolation'\) <> 'read committed'/);
  assert.match(helper, /errcode='25001',message='telehealth_transaction_isolation_refused'/);
  assert.ok(helper.indexOf('telehealth_transaction_isolation_refused') < helper.indexOf('_actor := clinical_private.require_clinical_patient'));
  assert.equal(telehealthTransferAuthorityCandidate(parent, sql).candidate.contract, 'telehealth-transfer-authority-candidate/4');
});
