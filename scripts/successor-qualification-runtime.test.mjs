import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { INVENTORY_FLEET_SPECS } from './inventory-qualification-fleet-specs.mjs';
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from './successor-qualification-release.mjs';
import { crc32 } from './care-messaging-zip.mjs';
let directory, summary;
const sha = v => createHash('sha256').update(v).digest('hex');
const read = (...names) => readFileSync(join(directory, ...names));
const json = (...names) => JSON.parse(read(...names));
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-successor-runtime-'));
  execFileSync(process.execPath, ['scripts/build-successor-qualification-runtime.mjs', `--out-dir=${directory}`], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  summary = json('manifest.json');
});
after(() => {
  if (!directory) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(directory)) !== realpathSync(tmpdir())
    || !basename(directory).startsWith('alp-successor-runtime-')) throw Error('successor_runtime_cleanup_refused');
  rmSync(directory, { recursive: true, force: false });
});
function zipFiles(bytes) {
  const files = []; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    assert.equal(bytes.readUInt16LE(offset + 28), 0);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    const data = bytes.subarray(offset + 30 + length, offset + 30 + length + size);
    assert.equal(bytes.readUInt32LE(offset + 14), crc32(data));
    assert.equal(bytes.readUInt32LE(offset + 22), size);
    files.push({ name, bytes: data }); offset += 30 + length + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50); assert.equal(bytes.readUInt16LE(bytes.length - 12), files.length);
  return files;
}
function evaluate(v, t, p) {
  if (!v || typeof v !== 'object') return v;
  if ('Ref' in v) { assert.ok(v.Ref in p); return p[v.Ref]; }
  if ('Condition' in v) return evaluate(t.Conditions[v.Condition], t, p);
  if ('Fn::Equals' in v) return evaluate(v['Fn::Equals'][0], t, p) === evaluate(v['Fn::Equals'][1], t, p);
  if ('Fn::And' in v) return v['Fn::And'].every(x => evaluate(x, t, p));
  if ('Fn::Or' in v) return v['Fn::Or'].some(x => evaluate(x, t, p));
  if ('Fn::Not' in v) return !evaluate(v['Fn::Not'][0], t, p);
  throw Error('unknown conditional');
}
test('declared runtime set is exact, all bytes bound, and no complete-fleet or activation claim', () => {
  assert.equal(summary.contract, 'successor-qualification-runtime-build/1');
  assert.equal(summary.scope, 'twelve-existing-request-candidates');
  assert.equal(summary.artifactSetCompleteForDeclaredScope, true);
  for (const k of ['completeFleetQualified', 'targetBindingComplete', 'deploymentPerformed', 'hostedVerified', 'phiAllowed']) assert.equal(summary[k], false);
  assert.equal(summary.activation, 'blocked');
  assert.equal(summary.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  for (const [k, v] of Object.entries(release)) assert.equal(summary[k], v);
  assert.deepEqual(summary.candidates.map(c => c.candidate).sort(), [...INVENTORY_FLEET_SPECS.map(s => s.name), 'care-messaging', 'care-connections'].sort());
  let functions = 0, packages = 0;
  for (const c of summary.candidates) {
    assert.equal(c.manifestSha256, sha(read(c.candidate, 'artifact-manifest.json')));
    assert.equal(c.templateSha256, sha(read(c.candidate, 'template.json')));
    const m = json(c.candidate, 'artifact-manifest.json'), t = json(c.candidate, 'template.json');
    for (const k of [...Object.keys(release), 'sourceCommit', 'sourceInputSha256', 'sourceClean']) assert.equal(m[k], summary[k]);
    functions += m.lambdaBindings.length;
    for (const p of m.packages) {
      packages++;
      const bytes = read(c.candidate, p.file); assert.equal(p.sha256, sha(bytes)); assert.equal(p.bytes, bytes.length);
      const files = zipFiles(bytes); assert.deepEqual(files.map(f => f.name), p.files.map(f => f.name));
      for (const [i, f] of files.entries()) { assert.equal(p.files[i].sha256, sha(f.bytes)); assert.equal(p.files[i].bytes, f.bytes.length); }
      for (const binding of m.lambdaBindings.filter(b => b.keyParameter === p.keyParameter)) {
        const handler = t.Resources[binding.logicalId].Properties.Handler;
        assert.equal(handler, binding.handler); assert.ok(files.some(f => f.name === binding.file));
        // Execute the actual packaged CJS entry point with a disabled target.
        // No fixture intercept or provider credential; workers must reject.
        const invoke = `const m=require(${JSON.stringify(join(directory, c.candidate, binding.file))});Promise.resolve(m[${JSON.stringify(handler.split('.')[1])}]({})).then(r=>{if(${JSON.stringify(binding.kind)}==='worker'||r.statusCode!==503||r.headers?.['x-clinical-execution'])process.exit(2)}).catch(e=>{if(${JSON.stringify(binding.kind)}!=='worker'||e.message!=='successor_qualification_unavailable')process.exit(3)});`;
        execFileSync(process.execPath, ['-e', invoke], { encoding: 'utf8', timeout: 10000, windowsHide: true,
          env: { ...process.env, QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'false' } });
      }
    }
  }
  assert.equal(functions, 15); assert.equal(packages, 13);
});
for (const name of [...INVENTORY_FLEET_SPECS.map(s => s.name), 'care-messaging', 'care-connections']) {
  test(`${name} retains all original reviews, IAM, routes and conditions, with separate exact successor pins`, () => {
    const parent = json(name, 'historical-builder', 'template.json'), t = json(name, 'template.json');
    assert.deepEqual(t.Rules, parent.Rules);
    for (const [id, r] of Object.entries(parent.Resources)) if (r.Type !== 'AWS::Lambda::Function') assert.deepEqual(t.Resources[id], r);
    for (const [n, c] of Object.entries(parent.Conditions)) if (n !== 'Qualification') assert.deepEqual(t.Conditions[n], c);
    assert.deepEqual(t.Conditions.Qualification['Fn::And'][0], parent.Conditions.Qualification);
    assert.deepEqual(t.Parameters.PhiAllowed.AllowedValues, ['false']); assert.deepEqual(t.Parameters.Activation.AllowedValues, ['blocked']);
    assert.equal(t.Parameters.QualificationExecution.Default, 'disabled');
    for (const [n, p] of Object.entries(parent.Parameters)) if (/ReviewSha256$/.test(n)) assert.deepEqual(t.Parameters[n], p);
    assert.equal(t.Parameters.InventoryQualificationProfile, undefined);
    const p = { ...Object.fromEntries(Object.entries(t.Parameters).map(([n, d]) => [n, d.Default || 'fictional'])),
      PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: '588966314750',
      QualificationIdentitySubjects: 'fictional-consumer-00001,fictional-workforce-00001', DatabaseName: 'clinical_core_qualification',
      SourceCommit: summary.sourceCommit, SourceInputSha256: summary.sourceInputSha256, MigrationReleaseSha256: release.migrationReleaseSha256,
      MigrationAssemblySha256: release.migrationAssemblySha256, SuccessorQualificationProfile: release.qualificationProfile,
      'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2' };
    assert.equal(evaluate(t.Conditions.Qualification, t, p), true); assert.equal(evaluate(t.Conditions.Active, t, p), false);
    for (const [k, v] of Object.entries({ 'AWS::AccountId': '173535830222', DatabaseName: 'clinical_core',
      SourceInputSha256: '4'.repeat(64), MigrationAssemblySha256: '4'.repeat(64), MigrationReleaseSha256: '4'.repeat(64),
      SuccessorQualificationProfile: 'adopted-plan-inventory-qualification/1', PhiAllowed: 'true', QualificationExecution: 'disabled' }))
      assert.equal(evaluate(t.Conditions.Qualification, t, { ...p, [k]: v }), false, k);
    for (const k of Object.keys(t.Parameters).filter(k => /ReviewSha256$/.test(k)))
      if (JSON.stringify(parent.Conditions.Qualification).includes(`"${k}"`))
        assert.equal(evaluate(t.Conditions.Qualification, t, { ...p, [k]: '' }), false, k);
    for (const r of Object.values(t.Resources).filter(r => r.Type === 'AWS::Lambda::Function')) {
      assert.equal(r.Properties.Environment.Variables.INVENTORY_QUALIFICATION_PROFILE, undefined);
      assert.deepEqual(r.Properties.Environment.Variables.SUCCESSOR_QUALIFICATION_PROFILE, { Ref: 'SuccessorQualificationProfile' });
      assert.deepEqual(r.Properties.Environment.Variables.MIGRATION_ASSEMBLY_SHA256, { Ref: 'MigrationAssemblySha256' });
    }
  });
}
