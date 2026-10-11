import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { assertClinicLocalSourcePrefix, assertClinicCompiledLocalSource } from './clinic-source-definition-admission.mjs';
const receipt = JSON.parse(readFileSync(new URL('../infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));

test('accepts all five independent source projections without granting runtime admission', () => {
  const compiled = structuredClone(receipt); compiled.ownerProfile.database_name = 'alp_owner_source_' + 'a'.repeat(32);
  const result = assertClinicCompiledLocalSource(artifact, receipt, compiled);
  assert.deepEqual(result.checkedPrefixes, [112, 113, 114, 115, 116]);
  assert.equal(result.exactDefinitionsMatched, true);
  for (const key of ['runtimeAdmission', 'managedRoleSemanticsVerified', 'custodyProven', 'upgradeAuthorized', 'providerAuthorized', 'phiAllowed'])
    assert.equal(result[key], false);
  assert.equal(result.activation, 'blocked');
});
for (const prefix of [112, 113, 114, 115, 116]) {
  test('exact independent source definition match at ' + prefix, () => {
    const result = assertClinicLocalSourcePrefix(artifact, receipt, prefix, receipt.snapshots[prefix - 112].projection);
    assert.equal(result.migrationCount, prefix); assert.equal(result.runtimeAdmission, false);
  });
  for (const kind of ['function:', 'relation:', 'role:', 'membership:', 'type:'])
    test('same-name changed ' + kind + ' definition refused at ' + prefix, () => {
      const projection = structuredClone(receipt.snapshots[prefix - 112].projection);
      const entry = projection.find(row => row.name.startsWith(kind)); assert.ok(entry);
      entry.digest = 'a'.repeat(64);
      assert.throws(() => assertClinicLocalSourcePrefix(artifact, receipt, prefix, projection), /admission_refused/);
    });
  for (const [label, mutate] of [
    ['missing', rows => rows.pop()], ['extra', rows => rows.push({ name: 'unsafe', digest: 'a'.repeat(64) })],
    ['duplicate', rows => rows.splice(1, 0, rows[0])], ['reordered', rows => rows.reverse()],
    ['unknown field', rows => { rows[0].approval = true; }],
  ]) test(label + ' projection refused at ' + prefix, () => {
    const projection = structuredClone(receipt.snapshots[prefix - 112].projection); mutate(projection);
    assert.throws(() => assertClinicLocalSourcePrefix(artifact, receipt, prefix, projection), /admission_refused/);
  });
}
for (const value of [111, 117, 112.5, '112', null, undefined]) test('refuses unsupported prefix ' + String(value), () => {
  assert.throws(() => assertClinicLocalSourcePrefix(artifact, receipt, value, receipt.snapshots[0].projection), /admission_refused/);
});
for (const [label, mutate] of [
  ['superuser', row => { row.ownerProfile.rolsuper = true; }],
  ['bypass RLS', row => { row.ownerProfile.rolbypassrls = true; }],
  ['different session', row => { row.ownerProfile.session_owner = 'postgres'; }],
  ['SET ROLE disguise', row => { row.ownerProfile.owner = 'postgres'; }],
  ['different engine', row => { row.postgresVersion = '17.8'; }],
  ['managed target', row => { row.ownerProfile.database_name = 'clinical_core_qualification'; }],
  ['production target', row => { row.ownerProfile.database_name = 'clinical_core_production'; }],
  ['claimed approval', row => { row.upgradeAuthorized = true; }],
  ['claimed runtime authority', row => { row.runtimeAdmission = true; }],
  ['claimed managed equivalence', row => { row.managedRoleSemanticsVerified = true; }],
  ['claimed PHI', row => { row.phiAllowed = true; }],
  ['unbound projection SQL', row => { row.projectionSqlSha256 = 'a'.repeat(64); }],
  ['changed installer', row => { row.installerBundleSha256 = 'a'.repeat(64); }],
  ['unknown field', row => { row.reviewed = true; }],
  ['missing prefix', row => { row.snapshots.pop(); }],
  ['duplicate prefix', row => { row.snapshots[4] = row.snapshots[3]; }],
]) test('compiled source refuses ' + label, () => {
  const compiled = structuredClone(receipt); mutate(compiled);
  assert.throws(() => assertClinicCompiledLocalSource(artifact, receipt, compiled), /admission_refused/);
});
test('cannot learn new expected definitions from a modified target-shaped receipt', () => {
  const substituted = structuredClone(receipt); substituted.snapshots[4].projection[0].digest = 'a'.repeat(64);
  assert.throws(() => assertClinicCompiledLocalSource(artifact, substituted, substituted), /source_refused/);
});
test('source bytes are validated before any observed schema is admitted', () => {
  const changed = structuredClone(artifact); changed.files[changed.manifest.migrations[115].file] += '\n';
  assert.throws(() => assertClinicCompiledLocalSource(changed, receipt, receipt), /artifact_refused/);
});
