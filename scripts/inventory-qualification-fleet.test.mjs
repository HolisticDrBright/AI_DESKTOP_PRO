import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVENTORY_FLEET_SPECS } from './inventory-qualification-fleet-specs.mjs';
import { inventoryFleetTemplate } from './inventory-qualification-fleet-template.mjs';
import { INVENTORY_PROFILE, INVENTORY_RELEASE } from './inventory-care-qualification-template.mjs';
import { inventoryQualificationZip } from './inventory-qualification-zip.mjs';
import { crc32 } from './care-messaging-zip.mjs';

let directory, summary;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (...names) => readFileSync(join(directory, ...names));
const json = (...names) => JSON.parse(read(...names));
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-inventory-fleet-'));
  execFileSync(process.execPath, ['scripts/build-inventory-qualification-fleet.mjs', `--out-dir=${directory}`], {
    encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024,
  });
  summary = json('manifest.json');
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

function evaluate(value, template, parameters) {
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) { assert.ok(value.Ref in parameters, value.Ref); return parameters[value.Ref]; }
  if ('Condition' in value) return evaluate(template.Conditions[value.Condition], template, parameters);
  if ('Fn::Equals' in value) return evaluate(value['Fn::Equals'][0], template, parameters) === evaluate(value['Fn::Equals'][1], template, parameters);
  if ('Fn::And' in value) return value['Fn::And'].every(v => evaluate(v, template, parameters));
  if ('Fn::Or' in value) return value['Fn::Or'].some(v => evaluate(v, template, parameters));
  if ('Fn::Not' in value) return !evaluate(value['Fn::Not'][0], template, parameters);
  throw Error(`unsupported condition ${JSON.stringify(value)}`);
}
function references(value, template, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if ('Ref' in value) found.add(value.Ref);
  else if ('Condition' in value) references(template.Conditions[value.Condition], template, found);
  else for (const v of Object.values(value)) if (Array.isArray(v)) v.forEach(x => references(x, template, found));
  return found;
}
function parameters(t) {
  // Fictional evaluator values, NEVER approval hashes or deployable input.
  return { ...Object.fromEntries(Object.entries(t.Parameters).map(([n, p]) => [n, p.Default || 'fictional'])),
    PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: '588966314750',
    QualificationIdentitySubjects: 'fictional-consumer-00001,fictional-workforce-00001',
    DatabaseName: 'clinical_core_qualification', SourceCommit: summary.sourceCommit, MigrationReleaseSha256: INVENTORY_RELEASE,
    InventoryQualificationProfile: INVENTORY_PROFILE, 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2' };
}
function zipContents(bytes) {
  const files = []; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0); // stored, not an unchecked decompression
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26);
    assert.equal(bytes.readUInt16LE(offset + 28), 0);
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString();
    const data = bytes.subarray(offset + 30 + length, offset + 30 + length + size);
    assert.equal(bytes.readUInt32LE(offset + 14), crc32(data));
    assert.equal(bytes.readUInt32LE(offset + 22), size);
    files.push({ name, bytes: data }); offset += 30 + length + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 12), files.length);
  return files;
}

test('complete artifacts are twelve candidates, not deployed, target-bound, hosted or PHI approved', () => {
  assert.equal(summary.contract, 'inventory-qualification-fleet-build/1');
  assert.equal(summary.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.match(summary.sourceInputSha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.migrationCount, 107); assert.equal(summary.migrationReleaseSha256, INVENTORY_RELEASE);
  assert.equal(summary.qualificationProfile, INVENTORY_PROFILE); assert.equal(summary.artifactSetComplete, true);
  for (const key of ['targetBindingComplete', 'deploymentPerformed', 'hostedVerified', 'phiAllowed']) assert.equal(summary[key], false);
  assert.equal(summary.activation, 'blocked');
  assert.deepEqual(summary.candidates.map(c => c.candidate).sort(), [...INVENTORY_FLEET_SPECS.map(s => s.name), 'care-messaging', 'care-connections'].sort());
  let count = 0;
  for (const c of summary.candidates) {
    assert.equal(c.manifestSha256, sha(read(c.candidate, 'artifact-manifest.json')));
    assert.equal(c.templateSha256, sha(read(c.candidate, 'template.json')));
    const m = json(c.candidate, 'artifact-manifest.json');
    for (const k of ['sourceCommit', 'sourceClean', 'sourceInputSha256', 'migrationCount', 'migrationReleaseSha256', 'qualificationProfile']) assert.equal(m[k], summary[k]);
    count += Object.values(json(c.candidate, 'template.json').Resources).filter(r => r.Type === 'AWS::Lambda::Function').length;
    for (const p of c.packages) {
      const bytes = read(c.candidate, p.file); assert.equal(p.sha256, sha(bytes)); assert.equal(p.bytes, bytes.length);
      zipContents(bytes);
    }
  }
  assert.equal(count, 15);
});

for (const spec of INVENTORY_FLEET_SPECS) {
  const get = () => ({ parent: json(spec.name, 'historical-builder', 'template.json'),
    t: json(spec.name, 'template.json'), m: json(spec.name, 'artifact-manifest.json') });
  test(`${spec.name}: preserve IAM, routes, reviews, retention and non-qualification conditions`, () => {
    const { parent, t, m } = get();
    assert.equal(m.parentTemplateSha256, sha(read(spec.name, 'historical-builder', 'template.json')));
    assert.deepEqual(t.Rules, parent.Rules);
    const lambdaNames = spec.functions.map(f => f.id);
    for (const [name, resource] of Object.entries(parent.Resources)) {
      if (!lambdaNames.includes(name)) { assert.deepEqual(t.Resources[name], resource, name); continue; }
      const original = structuredClone(resource), narrowed = structuredClone(t.Resources[name]);
      delete original.Properties.Code.S3ObjectVersion; delete narrowed.Properties.Code.S3ObjectVersion;
      delete original.Properties.Handler; delete narrowed.Properties.Handler;
      for (const key of ['SOURCE_COMMIT', 'MIGRATION_RELEASE_SHA256', 'INVENTORY_QUALIFICATION_PROFILE', 'DEPLOYMENT_ACCOUNT_ID']) {
        delete original.Properties.Environment.Variables[key]; delete narrowed.Properties.Environment.Variables[key];
      }
      assert.deepEqual(narrowed, original, name);
    }
    for (const [n, condition] of Object.entries(parent.Conditions)) if (n !== 'Qualification') assert.deepEqual(t.Conditions[n], condition);
    assert.deepEqual(t.Conditions.Qualification['Fn::And'][0], parent.Conditions.Qualification);
    assert.deepEqual(t.Parameters.PhiAllowed.AllowedValues, ['false']); assert.deepEqual(t.Parameters.Activation.AllowedValues, ['blocked']);
    assert.deepEqual(t.Parameters.DatabaseName.AllowedValues, ['clinical_core_qualification']);
    assert.deepEqual(t.Parameters.SourceCommit.AllowedValues, [summary.sourceCommit]);
    assert.deepEqual(t.Parameters.MigrationReleaseSha256.AllowedValues, [INVENTORY_RELEASE]);
    assert.equal(t.Parameters.QualificationExecution.Default, 'disabled');
    for (const [n, p] of Object.entries(parent.Parameters)) if (/ReviewSha256$/.test(n)) assert.deepEqual(t.Parameters[n], p);
  });
  test(`${spec.name}: refuse changed target/posture and all required reviews`, () => {
    const { t } = get(), p = parameters(t);
    assert.equal(evaluate(t.Conditions.Qualification, t, p), true);
    assert.equal(evaluate(t.Conditions.Active, t, p), false);
    const altered = { 'AWS::AccountId': '173535830222', 'AWS::Region': 'us-west-2', QualificationAccountId: '173535830222',
      DatabaseName: 'clinical_core', SourceCommit: '4'.repeat(40), MigrationReleaseSha256: '4'.repeat(64), InventoryQualificationProfile: 'old',
      PhiAllowed: 'true', Activation: 'approved', QualificationExecution: 'disabled', QualificationIdentitySubjects: '', AlarmTopicArn: '' };
    for (const n of references(t.Conditions.Qualification, t)) if (/ReviewSha256$|WorkerSha256$/.test(n)) altered[n] = '';
    for (const [n, v] of Object.entries(altered)) assert.equal(evaluate(t.Conditions.Qualification, t, { ...p, [n]: v }), false, n);
  });
  test(`${spec.name}: every handler, version and external runtime is inside the matching deterministic package`, () => {
    const { t, m } = get(); assert.equal(m.productionActivationPossible, false);
    assert.equal(m.lambdaBindings.length, spec.functions.length);
    for (const p of m.packages) {
      const files = zipContents(read(spec.name, p.file));
      assert.deepEqual(files.map(f => f.name), p.files.map(f => f.name));
      assert.deepEqual(read(spec.name, p.file), inventoryQualificationZip(files));
      for (const f of p.files) {
        const bytes = read(spec.name, f.name); assert.equal(f.sha256, sha(bytes)); assert.equal(f.bytes, bytes.length);
        assert.deepEqual(files.find(entry => entry.name === f.name).bytes, bytes);
      }
      const version = t.Parameters[p.versionParameter]; assert.equal(version.Type, 'String'); assert.ok(version.MinLength >= 1);
      assert.equal(version.Default, undefined); assert.equal(new RegExp(version.AllowedPattern).test('null'), false);
      assert.equal(t.Parameters[p.keyParameter].Default, undefined);
    }
    for (const f of spec.functions) {
      const binding = m.lambdaBindings.find(b => b.logicalId === f.id), properties = t.Resources[f.id].Properties;
      assert.equal(properties.Runtime, 'nodejs22.x'); assert.equal(properties.Handler, `${f.file.slice(0, -3)}.${f.exportName}`);
      const p = m.packages.find(p => p.keyParameter === binding.keyParameter);
      assert.ok(p.files.some(p => p.name === f.file));
      assert.deepEqual(properties.Code.S3ObjectVersion, { Ref: p.versionParameter });
      if (spec.runtime) { assert.ok(p.files.some(p => p.name === spec.runtime)); assert.deepEqual(read(spec.name, spec.runtime), read(spec.name, 'historical-builder', spec.runtime)); }
    }
  });
  test(`${spec.name}: real compiled exports refuse disabled execution without provider access`, () => {
    for (const f of spec.functions) {
      const entry = join(directory, spec.name, f.file);
      const result = JSON.parse(execFileSync(process.execPath, ['-e',
        `const m=require(${JSON.stringify(entry)});if(typeof m[${JSON.stringify(f.exportName)}]!=='function')process.exit(3);Promise.resolve().then(()=>m[${JSON.stringify(f.exportName)}]({})).then(r=>process.stdout.write(JSON.stringify({result:r})),e=>process.stdout.write(JSON.stringify({error:e.message})));`],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'false', AWS_EC2_METADATA_DISABLED: 'true' } }));
      if (f.kind === 'worker') assert.deepEqual(result, { error: 'inventory_qualification_unavailable' });
      else { assert.equal(result.result.statusCode, 503); assert.equal(result.result.headers['x-clinical-execution'], undefined); }
    }
  });
  test(`${spec.name}: parent resource drift is refused, not silently mapped`, () => {
    const { parent } = get(), id = spec.functions[0].id;
    for (const change of [p => { p.Parameters.PhiAllowed.Default = 'true'; }, p => { delete p.Conditions.Qualification; },
      p => { delete p.Resources[id]; }, p => { p.Resources.Invented = structuredClone(p.Resources[id]); },
      p => { p.Resources[id].Properties.Handler = 'wrong.handler'; }, p => { delete p.Resources[id].Properties.Environment.Variables[spec.functions[0].activation]; },
      p => { p.Resources[id].Properties.Code.S3Key = 'unbound'; }, p => { p.Resources[id].Properties.Code.S3ObjectVersion = 'unbound'; }]) {
      const bad = structuredClone(parent); change(bad);
      assert.throws(() => inventoryFleetTemplate(bad, summary.sourceCommit, spec), /inventory_fleet_/);
    }
  });
}
test('fleet builder refuses activation, PHI and target overrides before building', () => {
  for (const flag of ['--activate', '--phi-allowed=true', '--target=production', '--out-dir=']) assert.throws(() => execFileSync(process.execPath,
    ['scripts/build-inventory-qualification-fleet.mjs', flag], { stdio: 'pipe', timeout: 10000 }));
});
