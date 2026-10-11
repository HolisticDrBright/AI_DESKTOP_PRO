import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertClinicSourceArtifact, compileClinicSchemaRestrictedOwnerSource, CLINIC_SOURCE_IDENTITY } from './compile-clinic-schema-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
test('only the exact clinic 116 source assembly is admitted', () => {
  assert.equal(assertClinicSourceArtifact(artifact), artifact);
  assert.equal(artifact.manifest.migrations.length, CLINIC_SOURCE_IDENTITY.count);
  assert.equal(artifact.releaseHash, CLINIC_SOURCE_IDENTITY.assembly);
});
const mutations = [
  ['missing candidate', a => { delete a.candidate; }],
  ['unknown top-level approval', a => { a.approved = true; }],
  ['unknown manifest permission', a => { a.manifest.upgradeAuthorized = true; }],
  ['unknown candidate permission', a => { a.candidate.runtimeAdmission = true; }],
  ['old contract', a => { a.candidate.contract = 'clinic-record-privacy-candidate/3'; }],
  ['old parent', a => { a.candidate.parentMigrationCount = 113; }],
  ['old count', a => { a.candidate.migrationCount = 114; }],
  ['PHI', a => { a.candidate.phiAllowed = true; }],
  ['activation', a => { a.candidate.activation = 'approved'; }],
  ['deployment', a => { a.candidate.deployment = 'deployed'; }],
  ...['seededApprovals', 'seededConsents', 'seededTransfers', 'seededAdmissionKeys', 'seededDisclosureReleases', 'seededRequests']
    .map(key => [key, a => { a.candidate[key] = true; }]),
  ['string false', a => { a.candidate.phiAllowed = 'false'; }],
  ['missing posture', a => { delete a.candidate.activation; }],
  ['missing row', a => { a.manifest.migrations.pop(); }],
  ['duplicate row', a => { a.manifest.migrations[115] = a.manifest.migrations[114]; }],
  ['reordered rows', a => { [a.manifest.migrations[0], a.manifest.migrations[1]] = [a.manifest.migrations[1], a.manifest.migrations[0]]; }],
  ['unknown row field', a => { a.manifest.migrations[115].reviewed = true; }],
  ['path traversal', a => { a.manifest.migrations[115].file = '../candidate.sql'; }],
  ['missing file', a => { delete a.files[a.manifest.migrations[115].file]; }],
  ['extra file', a => { a.files['extra.sql'] = 'select 1'; }],
  ['line ending drift', a => { const f = a.manifest.migrations[115].file; a.files[f] = a.files[f].replaceAll('\n', '\r\n'); }],
  ['parent byte drift', a => { a.files[a.manifest.migrations[0].file] += '\n'; }],
  ['key fence byte drift', a => { a.files[a.manifest.migrations[114].file] += '\n'; }],
  ['clinic byte drift', a => { a.files[a.manifest.migrations[115].file] += '\n'; }],
  ['release drift', a => { a.releaseHash = '0'.repeat(64); }],
  ['parent hash drift', a => { a.candidate.parentArtifactSha256 = '0'.repeat(64); }],
  ['ledger hash drift', a => { a.candidate.migrationReleaseSha256 = '0'.repeat(64); }],
];
for (const [name, mutate] of mutations) test('clinic source refuses ' + name, () => {
  const changed = structuredClone(artifact); mutate(changed);
  assert.throws(() => assertClinicSourceArtifact(changed), /clinic_source_artifact_refused/);
});
for (const value of [null, [], {}, { ...artifact, files: [] }, { ...artifact, manifest: null }])
  test('clinic source refuses malformed artifact ' + JSON.stringify(value).slice(0, 50), () =>
    assert.throws(() => assertClinicSourceArtifact(value), /clinic_source_artifact_refused/));

const identity = { database_name: 'alp_owner_source_' + 'a'.repeat(32), owner: 'clinical_admin', session_owner: 'clinical_admin',
  database_owner: 'clinical_admin', version: '17.7', rolsuper: false, rolcreaterole: true, rolcreatedb: true,
  rolinherit: true, rolbypassrls: false, rolcanlogin: true, rolreplication: false };
for (const patch of [{ database_name: 'clinical_core_qualification' }, { database_name: 'clinical_core' },
  { owner: 'postgres' }, { session_owner: 'postgres' }, { database_owner: 'postgres' }, { rolsuper: true },
  { rolbypassrls: true }, { rolreplication: true }, { version: '18.3' }, { upgradeAuthorized: true }])
  test('clinic compiler refuses identity before any write ' + JSON.stringify(patch), async () => {
    let queries = 0;
    const db = { query: async () => { queries++; return { rows: [{ ...identity, ...patch }] }; },
      exec: async () => assert.fail('must not execute SQL'), transaction: async () => assert.fail('must not begin writes') };
    await assert.rejects(compileClinicSchemaRestrictedOwnerSource(db), /owner_refused/);
    assert.equal(queries, 1);
  });
for (const patch of [{ namespaces: 1 }, { roles: 1 }, { memberships: 1 }, { public_relations: 1 },
  { memberships: null }, { roles: '0' }, { extra: 0 }])
  test('clinic compiler refuses occupied or malformed source catalog ' + JSON.stringify(patch), async () => {
    let queries = 0;
    const db = { query: async () => ({ rows: ++queries === 1 ? [identity] : [{ namespaces: 0, roles: 0, memberships: 0, public_relations: 0, ...patch }] }),
      exec: async () => assert.fail('must not execute SQL'), transaction: async () => assert.fail('must not begin writes') };
    await assert.rejects(compileClinicSchemaRestrictedOwnerSource(db), /not_empty/);
    assert.equal(queries, 2);
  });
for (const args of [[], ['--target', 'production'], ['--connection-string', 'postgres://remote/db'],
  ['--binary-directory', 'relative', '--driver-directory', 'relative'],
  ...['--phi', '--activation', '--owner-profile', '--matrix', '--target', '--credential', '--review-hash']
    .map(flag => ['--binary-directory', root, '--driver-directory', root, flag, 'supplied'])])
  test('clinic CLI refuses alternate targets and authority inputs ' + JSON.stringify(args), () => {
    const run = spawnSync(process.execPath, ['scripts/qualify-clinic-native-source.mjs', ...args],
      { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(run.status, 1); assert.match(run.stderr, /arguments_refused/);
    assert.equal(run.stdout, '');
  });
