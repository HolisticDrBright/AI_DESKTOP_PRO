import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryCareTemplate, INVENTORY_PROFILE, INVENTORY_PARENT, INVENTORY_RELEASE } from './inventory-care-qualification-template.mjs';
import { crc32 } from './care-messaging-zip.mjs';
let directory, summary;
const sha = v => createHash('sha256').update(v).digest('hex');
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-inventory-care-'));
  execFileSync(process.execPath, ['scripts/build-inventory-care-qualification.mjs', `--out-dir=${directory}`], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
  });
  summary = JSON.parse(readFileSync(join(directory, 'manifest.json')));
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
function evaluate(value, template, parameters) {
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) { assert.ok(value.Ref in parameters, `missing evaluated parameter ${value.Ref}`); return parameters[value.Ref]; }
  if ('Condition' in value) return evaluate(template.Conditions[value.Condition], template, parameters);
  if ('Fn::Equals' in value) return evaluate(value['Fn::Equals'][0], template, parameters) === evaluate(value['Fn::Equals'][1], template, parameters);
  if ('Fn::And' in value) return value['Fn::And'].every(v => evaluate(v, template, parameters));
  if ('Fn::Or' in value) return value['Fn::Or'].some(v => evaluate(v, template, parameters));
  if ('Fn::Not' in value) return !evaluate(value['Fn::Not'][0], template, parameters);
  throw Error(`unsupported condition ${JSON.stringify(value)}`);
}
function qualificationParameters(template) {
  // Fictional evaluator only. Not deployment values or review evidence.
  return { ...Object.fromEntries(Object.entries(template.Parameters).map(([name, p]) => [name, p.Default ?? 'fictional'])),
    ...Object.fromEntries(Object.keys(template.Parameters).filter(n => /ReviewSha256$/.test(n)).map(n => [n, '2'.repeat(64)])),
    SourceCommit: summary.sourceCommit, MigrationReleaseSha256: INVENTORY_RELEASE, InventoryQualificationProfile: INVENTORY_PROFILE,
    DatabaseName: 'clinical_core_qualification', QualificationExecution: 'enabled', QualificationAccountId: '588966314750',
    QualificationIdentitySubjects: 'fictional-consumer-00001,fictional-workforce-00001', AlarmTopicArn: 'fictional-alarm',
    'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2' };
}
test('build records the real checkout and explicitly refuses a complete-fleet or hosted claim', () => {
  assert.equal(summary.contract, 'inventory-care-qualification-build/1');
  assert.equal(summary.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.match(summary.sourceInputSha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.migrationCount, 107); assert.equal(summary.migrationReleaseSha256, INVENTORY_RELEASE);
  for (const flag of ['fleetComplete', 'deploymentPerformed', 'hostedVerified', 'phiAllowed']) assert.equal(summary[flag], false);
  assert.equal(summary.activation, 'blocked'); assert.equal(summary.candidates.length, 2);
});
for (const kind of ['messaging', 'connections']) {
  const get = () => {
    const root = join(directory, `care-${kind}`);
    return { root, manifest: JSON.parse(readFileSync(join(root, 'artifact-manifest.json'))),
      parent: JSON.parse(readFileSync(join(root, 'historical-106/template.json'))), template: JSON.parse(readFileSync(join(root, 'template.json'))) };
  };
  test(`${kind}: files and code pins match the deterministic deployment ZIP`, () => {
    const { root, manifest } = get(), bytes = readFileSync(join(root, 'deployment.zip')), code = readFileSync(join(root, 'index.js'));
    assert.equal(manifest.sourceCommit, summary.sourceCommit); assert.equal(manifest.sourceClean, summary.sourceClean);
    assert.equal(manifest.sourceInputSha256, summary.sourceInputSha256); assert.equal(manifest.migrationCount, 107);
    assert.equal(manifest.qualificationProfile, INVENTORY_PROFILE); assert.equal(manifest.migrationReleaseSha256, INVENTORY_RELEASE);
    assert.equal(manifest.codeSha256, sha(code)); assert.equal(manifest.templateSha256, sha(readFileSync(join(root, 'template.json'))));
    assert.equal(manifest.deploymentZipSha256, sha(bytes)); assert.equal(manifest.deploymentZipBytes, bytes.length);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.equal(bytes.readUInt32LE(14), crc32(code));
    assert.equal(bytes.readUInt32LE(18), code.length); assert.equal(bytes.readUInt32LE(22), code.length);
    assert.equal(bytes.subarray(30, 38).toString(), 'index.js'); assert.deepEqual(bytes.subarray(38, 38 + code.length), code);
    assert.equal(bytes.readUInt16LE(bytes.length - 12), 1);
    assert.equal(manifest.functions.length, 7); if (kind === 'connections') assert.equal(manifest.claimFunctions.length, 2);
    const recorded = summary.candidates.find(c => c.candidate === manifest.candidate);
    assert.equal(recorded.manifestSha256, sha(readFileSync(join(root, 'artifact-manifest.json'))));
    for (const flag of ['deploymentPerformed', 'hostedVerified', 'activationApproved']) assert.equal(manifest[flag], false);
  });
  test(`${kind}: historical builder stays 106; every review, IAM and recovery condition is preserved`, () => {
    const { root, manifest, parent, template } = get();
    const historical = JSON.parse(readFileSync(join(root, 'historical-106/artifact-manifest.json')));
    assert.equal(historical.migrationCount, 106); assert.equal(historical.migrationReleaseSha256, INVENTORY_PARENT);
    assert.equal(manifest.parentTemplateSha256, sha(readFileSync(join(root, 'historical-106/template.json'))));
    assert.deepEqual(parent.Parameters.MigrationReleaseSha256.AllowedValues, [INVENTORY_PARENT]);
    assert.deepEqual(template.Rules, parent.Rules);
    for (const [name, resource] of Object.entries(parent.Resources)) if (name !== 'Function') assert.deepEqual(template.Resources[name], resource);
    const originalFunction = structuredClone(parent.Resources.Function), changedFunction = structuredClone(template.Resources.Function);
    delete originalFunction.Properties.Environment; delete changedFunction.Properties.Environment;
    assert.deepEqual(changedFunction, originalFunction);
    for (const [name, condition] of Object.entries(parent.Conditions)) if (name !== 'Qualification') assert.deepEqual(template.Conditions[name], condition);
    assert.deepEqual(template.Conditions.Qualification['Fn::And'][0], parent.Conditions.Qualification);
    assert.equal(template.Parameters.QualificationExecution.Default, 'disabled');
    assert.deepEqual(template.Parameters.PhiAllowed.AllowedValues, ['false']); assert.deepEqual(template.Parameters.Activation.AllowedValues, ['blocked']);
    assert.deepEqual(template.Parameters.DatabaseName.AllowedValues, ['clinical_core_qualification']);
    assert.deepEqual(template.Parameters.MigrationReleaseSha256.AllowedValues, [INVENTORY_RELEASE]);
    if (kind === 'connections') assert.equal(template.Parameters.ClaimRecoveryEnabled.Default, 'false');
  });
  test(`${kind}: qualification cannot bypass independent reviews or substitute a different target`, () => {
    const { template } = get(), p = qualificationParameters(template);
    assert.equal(evaluate(template.Conditions.Qualification, template, p), true);
    assert.equal(evaluate(template.Conditions.Active, template, p), false);
    for (const [name, value] of Object.entries({ 'AWS::AccountId': '173535830222', 'AWS::Region': 'us-west-2',
      DatabaseName: 'clinical_core', InventoryQualificationProfile: 'legacy', MigrationReleaseSha256: INVENTORY_PARENT,
      SourceCommit: '4'.repeat(40), PhiAllowed: 'true', Activation: 'approved', QualificationExecution: 'disabled',
      ...Object.fromEntries(Object.keys(template.Parameters).filter(n => /ReviewSha256$/.test(n) && n !== 'ClaimRecoveryReviewSha256').map(n => [n, ''])) })) {
      assert.equal(evaluate(template.Conditions.Qualification, template, { ...p, [name]: value }), false, name);
    }
    if (kind === 'connections') assert.equal(evaluate(template.Conditions.RecoveryEnabled, template, p), false);
  });
  test(`${kind}: malformed or stale parent templates are refused instead of rewritten as 107`, () => {
    const { parent } = get();
    for (const change of [p => { p.Parameters.SourceCommit.AllowedValues = ['4'.repeat(40)]; },
      p => { p.Parameters.MigrationReleaseSha256.AllowedValues = [INVENTORY_RELEASE]; },
      p => { p.Resources.Function.Properties.Handler = 'wrong.handler'; },
      p => { p.Parameters.PhiAllowed.Default = 'true'; }, p => { delete p.Conditions.Qualification; }]) {
      const bad = structuredClone(parent); change(bad);
      assert.throws(() => inventoryCareTemplate(bad, summary.sourceCommit), /inventory_care_template_parent_refused/);
    }
  });
  test(`${kind}: the actual compiled handler is inert without activation or an AWS client`, () => {
    const { root } = get();
    const response = JSON.parse(execFileSync(process.execPath, ['-e',
      `const {handler}=require(${JSON.stringify(join(root, 'index.js'))});handler({routeKey:'POST /clinical-core/consumer/messages'}).then(r=>process.stdout.write(JSON.stringify(r)))`],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'false' } }));
    assert.equal(response.statusCode, 503); assert.equal(response.headers['x-clinical-execution'], undefined);
  });
}
test('activation and target override arguments are not build options', () => {
  for (const flag of ['--activate', '--phi-allowed=true', '--target=production']) assert.throws(() => execFileSync(process.execPath,
    ['scripts/build-inventory-care-qualification.mjs', flag], { stdio: 'pipe', timeout: 10000 }));
});
