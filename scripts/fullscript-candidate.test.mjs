import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FULLSCRIPT_EXTENSIONS, fullscriptCandidate } from './fullscript-candidate.mjs';

const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true }));
const sources = Object.fromEntries(FULLSCRIPT_EXTENSIONS.map(e => [e.source,
  readFileSync(`infra/aws-clinical-core/source-candidates/${e.source}.sql`, 'utf8')]));
test('111 candidate preserves exact historical files, telehealth scope and blocked posture', () => {
  const a = fullscriptCandidate(parent, sources);
  assert.equal(a.manifest.migrations.length, 111);
  assert.deepEqual(a.manifest.migrations.slice(0, 108), parent.manifest.migrations);
  for (const [file, sql] of Object.entries(parent.files)) assert.equal(a.files[file], sql);
  assert.equal(a.candidate.phiAllowed, false); assert.equal(a.candidate.activation, 'blocked');
  assert.equal(a.candidate.deployment, 'not_deployed');
  assert.equal(a.candidate.extensions.length, 3);
});
test('Windows source bytes normalize to identical artifact without rewriting historical bytes', () => {
  const windows = Object.fromEntries(Object.entries(sources).map(([name, sql]) => [name, sql.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n')]));
  assert.deepEqual(fullscriptCandidate(parent, windows), fullscriptCandidate(parent, sources));
});
for (const [name, mutate] of Object.entries({
  'changed SQL': p => { p.files[p.manifest.migrations[0].file] += '\n'; },
  'renamed history': p => { p.manifest.migrations[0].file = p.manifest.migrations[0].file.replace('production', 'altered'); },
  'missing history': p => { p.manifest.migrations.pop(); },
  'duplicate history': p => { p.manifest.migrations[1] = p.manifest.migrations[0]; },
  'reordered history': p => { [p.manifest.migrations[0], p.manifest.migrations[1]] = [p.manifest.migrations[1], p.manifest.migrations[0]]; },
  'extra hidden SQL': p => { p.files['hidden.sql'] = 'select 1'; },
  'PHI activation': p => { p.candidate.phiAllowed = true; },
  'approved activation': p => { p.candidate.activation = 'approved'; },
  'deployed parent': p => { p.candidate.deployment = 'deployed'; },
  'wrong receipt': p => { p.candidate.migrationReleaseSha256 = 'a'.repeat(64); },
})) test(`refuses ${name}`, () => {
  const p = structuredClone(parent); mutate(p);
  assert.throws(() => fullscriptCandidate(p, sources), /artifact_refused/);
});
for (const e of FULLSCRIPT_EXTENSIONS) test(`refuses altered, missing or added ${e.source} statements`, () => {
  for (const value of ['', sources[e.source] + '\ninsert into clinical_core.organizations default values;', sources[e.source].replace('create ', 'create or replace ')]) {
    assert.throws(() => fullscriptCandidate(parent, { ...sources, [e.source]: value }), /artifact_refused/);
  }
  const missing = { ...sources }; delete missing[e.source];
  assert.throws(() => fullscriptCandidate(parent, missing), /artifact_refused/);
});
test('no approval, consent grant, fixture, role membership or destructive statement is appended by builder', () => {
  const a = fullscriptCandidate(parent, sources);
  for (const e of a.candidate.extensions) assert.equal(a.files[e.file], sources[FULLSCRIPT_EXTENSIONS.find(x => x.name === e.name).source].replace(/\r\n?/g, '\n'));
  assert.throws(() => fullscriptCandidate(parent, { ...sources, hidden: 'grant fullscript_draft_worker to clinical_core_api;' }), /artifact_refused/);
});
