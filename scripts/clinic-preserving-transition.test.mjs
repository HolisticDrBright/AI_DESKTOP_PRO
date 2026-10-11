import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildClinicPreservingTransition, assertClinicPreservingTransition, CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from './clinic-preserving-transition.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = readFileSync(new URL('../infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', import.meta.url));
const receipt = JSON.parse(bytes.toString('utf8'));
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
const plan = buildClinicPreservingTransition(artifact, receipt);
test('native receipt is pinned as source metadata, never activation evidence', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), CLINIC_NATIVE_SOURCE_RECEIPT_SHA256);
  assert.equal(bytes.includes(13), false);
  assert.equal(receipt.managedRoleSemanticsVerified, false);
  assert.equal(receipt.upgradeAuthorized, false);
  assert.equal(receipt.runtimeAdmission, false);
});
test('four exact transitions account for every permitted schema delta', () => {
  assert.deepEqual(plan.transitions.map(t => [t.toCount, t.addedObjects.length, t.changedObjects.length]),
    [[113, 10, 7], [114, 23, 4], [115, 0, 1], [116, 28, 4]]);
  for (const transition of plan.transitions) {
    const before = new Map(receipt.snapshots[transition.fromCount - 112].projection.map(r => [r.name, r.digest]));
    const after = new Map(receipt.snapshots[transition.toCount - 112].projection.map(r => [r.name, r.digest]));
    assert.deepEqual(transition.removedObjects, []);
    for (const item of transition.addedObjects) { assert.equal(before.has(item.name), false); assert.equal(after.get(item.name), item.digest); }
    for (const item of transition.changedObjects) { assert.equal(before.get(item.name), item.beforeSha256); assert.equal(after.get(item.name), item.afterSha256); }
    assert.equal(new Set([...transition.addedObjects, ...transition.changedObjects].map(r => r.name)).size,
      transition.addedObjects.length + transition.changedObjects.length);
  }
  assert.equal(assertClinicPreservingTransition(structuredClone(plan), artifact, receipt).sourceOnly, true);
});
test('preservation includes every parent table and all migration receipt fields', () => {
  const p = plan.preservation;
  assert.equal(p.historicalTableCount, 217); assert.equal(p.historicalTableNames.length, 217);
  assert.equal(new Set(p.historicalTableNames).size, 217);
  assert.ok(p.historicalTableNames.includes('clinical_private.owned_legal_holds'));
  assert.ok(p.historicalTableNames.includes('clinical_core.patient_records'));
  assert.ok(p.historicalTableNames.includes('clinical_core.clinical_note_versions'));
  assert.equal(p.ledgerTable, 'clinical_core.schema_migrations');
  for (const flag of ['allHistoricalReceiptColumnsRequired', 'completeRowDigestsRequired', 'rlsFilteredFingerprintForbidden',
    'singleTransactionRequired', 'canonicalSourceAtEveryPrefixRequired', 'rollbackReadbackRequired', 'custodyAndUnknownCommitRecoveryRequired'])
    assert.equal(p[flag], true);
  assert.equal(p.newTableCount, 11); assert.equal(p.newRowsRequired, 0);
  assert.equal(p.newTableNames.some(n => p.historicalTableNames.includes(n)), false);
});
test('proposed coverage is not a registered release or disclosure permission', () => {
  assert.equal(plan.proposedCoverage.length, 11);
  for (const row of plan.proposedCoverage) {
    assert.equal(row.status, 'unregistered_unreviewed_source_proposal');
    assert.equal(row.apiRoleDirectAccessAllowed, false); assert.equal(row.productionActivationAllowed, false);
  }
  assert.equal(plan.proposedCoverage.find(r => r.table.endsWith('telehealth_admission_keys')).disposition,
    'private_signing_material_counts_and_digests_only');
  for (const flag of ['runtimeAdmission', 'upgradeAuthorized', 'providerAuthorized', 'managedRoleSemanticsVerified', 'operatorAcceptance', 'phiAllowed'])
    assert.equal(plan[flag], false);
  assert.equal(plan.managedRuntimeProfileReviewRequired, true);
  assert.equal(plan.copyingLocalSchemaPinsToManagedRuntimeForbidden, true);
});
const receiptMutations = [
  ['runtime authority', r => { r.runtimeAdmission = true; }],
  ['managed equivalence', r => { r.managedRoleSemanticsVerified = true; }],
  ['upgrade approval', r => { r.upgradeAuthorized = true; }],
  ['provider approval', r => { r.providerAuthorized = true; }],
  ['PHI', r => { r.phiAllowed = true; }],
  ['engine', r => { r.postgresVersion = '18.3'; }],
  ['unknown review', r => { r.approval = true; }],
  ['missing profile', r => { delete r.ownerProfile; }],
  ['changed owner profile', r => { r.ownerProfile.rolsuper = true; }],
  ['missing prefix', r => { r.snapshots.pop(); }],
  ['duplicate prefix', r => { r.snapshots[4] = r.snapshots[3]; }],
  ['missing object', r => { r.snapshots[4].projection.pop(); }],
  ['changed object', r => { r.snapshots[4].projection[0].digest = '0'.repeat(64); }],
  ['claimed schema hash', r => { r.snapshots[4].schemaSha256 = '0'.repeat(64); }],
  ['changed installer', r => { r.installerBundleSha256 = '0'.repeat(64); }],
];
for (const [name, change] of receiptMutations) test('source transition refuses native receipt ' + name, () => {
  const r = structuredClone(receipt); change(r);
  assert.throws(() => buildClinicPreservingTransition(artifact, r), /source_refused/);
});
const planMutations = [
  ['authority', p => { p.upgradeAuthorized = true; }],
  ['false preservation', p => { p.preservation.required = false; }],
  ['omitted protected table', p => { p.preservation.historicalTableNames.pop(); }],
  ['RLS-filtered rows', p => { p.preservation.rlsFilteredFingerprintForbidden = false; }],
  ['copy local pins', p => { p.copyingLocalSchemaPinsToManagedRuntimeForbidden = false; }],
  ['missing rollback', p => { p.preservation.rollbackReadbackRequired = false; }],
  ['missing custody', p => { p.preservation.custodyAndUnknownCommitRecoveryRequired = false; }],
  ['seeded release', p => { p.preservation.newRowsRequired = 1; }],
  ['omitted changed object', p => { p.transitions[0].changedObjects.pop(); }],
  ['unknown object', p => { p.transitions[0].addedObjects.push({ name: 'unsafe', digest: '0'.repeat(64) }); }],
  ['removed object', p => { p.transitions[0].removedObjects.push('clinical_core.patient_records'); }],
  ['registration', p => { p.proposedCoverage[0].status = 'registered'; }],
  ['direct read', p => { p.proposedCoverage[0].apiRoleDirectAccessAllowed = true; }],
  ['unknown approval', p => { p.reviewed = true; }],
];
for (const [name, change] of planMutations) test('transition validator refuses ' + name, () => {
  const p = structuredClone(plan); change(p);
  assert.throws(() => assertClinicPreservingTransition(p, artifact, receipt), /transition_mismatch/);
});
for (const index of [0, 111, 112, 113, 114, 115]) test('source transition refuses changed migration at ' + index, () => {
  const a = structuredClone(artifact); a.files[a.manifest.migrations[index].file] += '\n';
  assert.throws(() => buildClinicPreservingTransition(a, receipt), /artifact_refused/);
});
for (const args of [['--target', 'clinical_core_qualification'], ['--approve'], ['--phi', 'true'], ['--profile', 'ai-synthetic-member']])
  test('source builder refuses runtime options ' + args.join(' '), () => {
    const r = spawnSync(process.execPath, ['scripts/build-clinic-preserving-transition.mjs', ...args],
      { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(r.status, 1); assert.match(r.stderr, /arguments_refused/); assert.equal(r.stdout, '');
  });
