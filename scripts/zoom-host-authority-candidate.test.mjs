import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { zoomHostAuthorityCandidate, ZOOM_HOST_AUTHORITY_FILE, ZOOM_HOST_AUTHORITY_PARENT } from './zoom-host-authority-candidate.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-chart-lifecycle-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const sql = readFileSync('infra/aws-clinical-core/source-candidates/zoom-host-authority.sql', 'utf8').replace(/\r\n?/g, '\n');

test('preserves all exact 113 files and adds one source-only blocked host migration', () => {
  const before = structuredClone(parent), a = zoomHostAuthorityCandidate(parent, sql);
  assert.deepEqual(parent, before);
  assert.equal(a.manifest.migrations.length, 114);
  assert.deepEqual(a.manifest.migrations.slice(0, 113), parent.manifest.migrations);
  assert.deepEqual(a.manifest.migrations[113], { version: '20261010200000', file: ZOOM_HOST_AUTHORITY_FILE });
  for (const m of parent.manifest.migrations) assert.equal(a.files[m.file], parent.files[m.file]);
  assert.equal(a.candidate.parentArtifactSha256, ZOOM_HOST_AUTHORITY_PARENT.assembly);
  assert.equal(a.candidate.parentMigrationReleaseSha256, ZOOM_HOST_AUTHORITY_PARENT.ledger);
  assert.equal(a.candidate.migrationReleaseSha256, '7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c');
  assert.equal(a.releaseHash, '8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e');
  assert.equal(a.candidate.contract, 'zoom-host-authority-candidate/1');
  assert.equal(a.candidate.activation, 'blocked'); assert.equal(a.candidate.phiAllowed, false);
  assert.equal(a.candidate.deployment, 'not_deployed');
  for (const [key, value] of Object.entries(a.candidate)) if (key.startsWith('seeded')) assert.equal(value, false);
  assert.deepEqual(zoomHostAuthorityCandidate(parent, sql.replaceAll('\n', '\r\n')), a);
  a.manifest.migrations[0].file = 'not-a-parent-edit.sql';
  assert.deepEqual(parent, before);
});

test('emits fifteen pins from exact compiled final bodies rather than runtime observations', () => {
  const a = zoomHostAuthorityCandidate(parent, sql), bodies = new Map();
  for (const row of a.manifest.migrations) for (const [, name, body] of a.files[row.file].matchAll(/create(?: or replace)? function (clinical_(?:private|telehealth)\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)) bodies.set(name, body);
  assert.equal(a.functionPins.length, 15); assert.equal(new Set(a.functionPins.map(p => p.name)).size, 15);
  for (const pin of a.functionPins) assert.equal(pin.bodySha256, sha(bodies.get(pin.name)));
  assert.equal(a.candidate.functionPinsSha256, sha(JSON.stringify(a.functionPins)));
  assert.equal(a.functionPins.filter(p => p.name.startsWith('clinical_telehealth.')).length, 10);
});

for (const [name, mutate] of [
  ['missing activation', p => { delete p.candidate.activation; }],
  ['approved activation', p => { p.candidate.activation = 'approved'; }],
  ['enabled PHI', p => { p.candidate.phiAllowed = true; }],
  ['deployed claim', p => { p.candidate.deployment = 'deployed'; }],
  ['seeded approvals', p => { p.candidate.seededApprovals = true; }],
  ['missing admission-key posture', p => { delete p.candidate.seededAdmissionKeys; }],
  ['seeded transfers', p => { p.candidate.seededTransfers = true; }],
  ['unlisted approval field', p => { p.candidate.approved = true; }],
  ['previous chart contract', p => { p.candidate.contract = 'telehealth-chart-lifecycle-candidate/3'; }],
  ['wrong parent count', p => { p.candidate.parentMigrationCount = 111; }],
  ['wrong count', p => { p.candidate.migrationCount = 114; }],
  ['wrong ledger claim', p => { p.candidate.migrationReleaseSha256 = 'a'.repeat(64); }],
  ['wrong extension claim', p => { p.candidate.extensionSha256 = 'b'.repeat(64); }],
  ['wrong assembly', p => { p.releaseHash = 'b'.repeat(64); }],
  ['wrong manifest contract', p => { p.manifest.contract_version = 'other/1'; }],
  ['extra manifest activation', p => { p.manifest.activation = 'approved'; }],
  ['extra SQL', p => { p.files['unlisted.sql'] = 'select 1;'; }],
  ['missing SQL', p => { delete p.files[p.manifest.migrations[0].file]; }],
  ['changed parent SQL', p => { p.files[p.manifest.migrations[0].file] += '\n-- drift'; }],
  ['changed chart extension', p => { p.files[p.manifest.migrations[112].file] += '\n-- drift'; }],
  ['missing row', p => { p.manifest.migrations.pop(); }],
  ['duplicate version', p => { p.manifest.migrations[1].version = p.manifest.migrations[0].version; }],
  ['reordered rows', p => { p.manifest.migrations.reverse(); }],
  ['null row', p => { p.manifest.migrations[0] = null; }],
  ['extra row field', p => { p.manifest.migrations[0].approved = true; }],
  ['path escape', p => { p.manifest.migrations[0].file = '../migration.sql'; }],
  ['non-string bytes', p => { p.files[p.manifest.migrations[0].file] = {}; }],
  ['parent CRLF drift', p => { const m = p.manifest.migrations[0]; p.files[m.file] = p.files[m.file].replaceAll('\n', '\r\n'); }],
]) test('refuses ' + name, () => {
  const p = structuredClone(parent); mutate(p);
  assert.throws(() => zoomHostAuthorityCandidate(p, sql), /zoom_host_authority_artifact_refused/);
});

test('refuses malformed parents and changed host authority, privileges or seeded reviews', () => {
  for (const value of [null, [], {}, { ...parent, files: [] }, { ...parent, candidate: null }]) {
    assert.throws(() => zoomHostAuthorityCandidate(value, sql), /zoom_host_authority_artifact_refused/);
  }
  for (const source of [null, sql + '\nselect 1;', sql.replace('force row level security', 'no force row level security'),
    sql + '\ninsert into clinical_telehealth.zoom_host_releases default values;',
    sql.replace('providerActionAuthorized\',false', 'providerActionAuthorized\',true')]) {
    assert.throws(() => zoomHostAuthorityCandidate(parent, source), /zoom_host_authority_artifact_refused/);
  }
});

test('command refuses activation, SQL application and alternate-source arguments', () => {
  for (const argument of ['--apply', '--activate', '--phi-allowed', '--source=other.sql']) {
    assert.throws(() => execFileSync(process.execPath, ['scripts/build-zoom-host-authority-candidate.mjs', argument],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: 'pipe' }), error => /zoom_host_authority_argument_refused/.test(error.stderr));
  }
});
