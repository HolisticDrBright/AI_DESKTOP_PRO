import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from './successor-qualification-release.mjs';
import { crc32 } from './care-messaging-zip.mjs';
import { successorProviderTemplate } from './successor-qualification-provider-template.mjs';
const sha = v => createHash('sha256').update(v).digest('hex');
let directory, summary;
const read = (...names) => readFileSync(join(directory, ...names)), json = (...names) => JSON.parse(read(...names));
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'alp-successor-providers-'));
  execFileSync(process.execPath, ['scripts/build-successor-qualification-providers.mjs', `--out-dir=${directory}`], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  summary = json('manifest.json');
});
after(() => {
  if (!directory) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(directory)) !== realpathSync(tmpdir())
    || !basename(directory).startsWith('alp-successor-providers-')) throw Error('successor_provider_cleanup_refused');
  rmSync(directory, { recursive: true, force: false });
});
function evaluate(v, t, p) {
  if (!v || typeof v !== 'object') return v;
  if ('Ref' in v) { assert.ok(v.Ref in p, v.Ref); return p[v.Ref]; }
  if ('Condition' in v) return evaluate(t.Conditions[v.Condition], t, p);
  if ('Fn::Equals' in v) return evaluate(v['Fn::Equals'][0], t, p) === evaluate(v['Fn::Equals'][1], t, p);
  if ('Fn::And' in v) return v['Fn::And'].every(x => evaluate(x, t, p));
  if ('Fn::Or' in v) return v['Fn::Or'].some(x => evaluate(x, t, p));
  if ('Fn::Not' in v) return !evaluate(v['Fn::Not'][0], t, p);
  if ('Fn::If' in v) return evaluate(v['Fn::If'][evaluate({ Condition: v['Fn::If'][0] }, t, p) ? 1 : 2], t, p);
  throw Error('unknown conditional');
}
function parameters(t) {
  const p = { ...Object.fromEntries(Object.entries(t.Parameters).map(([n, d]) => [n, d.Default || 'fictional'])),
    PhiAllowed: 'false', Activation: 'blocked', QualificationExecution: 'enabled', QualificationAccountId: '588966314750',
    QualificationIdentitySubjects: 'fictional-consumer-00001,fictional-workforce-00001', DatabaseName: 'clinical_core_qualification',
    SourceCommit: summary.sourceCommit, SourceInputSha256: summary.sourceInputSha256, SourceClean: String(summary.sourceClean),
    MigrationReleaseSha256: release.migrationReleaseSha256, MigrationAssemblySha256: release.migrationAssemblySha256,
    SuccessorQualificationProfile: release.qualificationProfile, 'AWS::AccountId': '588966314750', 'AWS::Region': 'us-east-2',
    AlarmTopicArn: 'arn:aws:sns:us-east-2:588966314750:fictional-test-alarms' };
  for (const key of Object.keys(t.Parameters)) if (/ReviewSha256$/.test(key) || key === 'ConfigurationSha256') p[key] = '3'.repeat(64);
  return p;
}
test('two real provider request artifacts carry exact byte identities without deployment or complete fleet claims', () => {
  assert.equal(summary.contract, 'successor-qualification-providers-build/1');
  assert.equal(summary.scope, 'telehealth-consent-and-clinic-records');
  assert.equal(summary.artifactSetCompleteForDeclaredScope, true);
  for (const k of ['completeFleetQualified', 'targetBindingComplete', 'deploymentPerformed', 'hostedVerified', 'phiAllowed']) assert.equal(summary[k], false);
  assert.equal(summary.activation, 'blocked');
  for (const [k, v] of Object.entries(release)) assert.equal(summary[k], v);
  assert.deepEqual(summary.candidates.map(c => c.candidate), ['telehealth-consent', 'clinic-records']);
  for (const c of summary.candidates) {
    assert.equal(c.manifestSha256, sha(read(c.candidate, 'artifact-manifest.json')));
    assert.equal(c.templateSha256, sha(read(c.candidate, 'template.json')));
    const m = json(c.candidate, 'artifact-manifest.json'), p = m.packages[0], zip = read(c.candidate, p.file), code = read(c.candidate, 'index.js');
    for (const key of [...Object.keys(release), 'sourceCommit', 'sourceClean', 'sourceInputSha256']) assert.equal(m[key], summary[key]);
    assert.equal(m.immutablePublishedVersionRequired, true); assert.equal(p.sha256, sha(zip)); assert.equal(p.bytes, zip.length);
    assert.equal(p.lambdaCodeSha256, createHash('sha256').update(zip).digest('base64'));
    assert.equal(p.files[0].sha256, sha(code)); assert.equal(p.files[0].bytes, code.length);
    assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt16LE(8), 0);
    const size = zip.readUInt32LE(18), length = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + length).toString(), 'index.js');
    assert.deepEqual(zip.subarray(30 + length, 30 + length + size), code); assert.equal(zip.readUInt32LE(14), crc32(code));
    assert.equal(json(c.candidate, 'template.json').Resources.Published.Properties.CodeSha256, p.lambdaCodeSha256);
  }
});
for (const name of ['telehealth-consent', 'clinic-records']) test(`${name} copy keeps original authority and reviews and binds the new immutable code`, () => {
  const t = json(name, 'template.json'), parent = json(name, 'historical-builder', 'template.json');
  assert.deepEqual(t.Parameters.PhiAllowed.AllowedValues, ['false']); assert.deepEqual(t.Parameters.Activation.AllowedValues, ['blocked']);
  assert.equal(t.Parameters.QualificationExecution.Default, 'disabled');
  assert.deepEqual(t.Parameters.DatabaseName.AllowedValues, ['clinical_core_qualification']);
  assert.equal(t.Parameters.InventoryQualificationProfile, undefined);
  assert.deepEqual(t.Resources.Role, parent.Resources.Role); assert.deepEqual(t.Resources.Logs, parent.Resources.Logs);
  for (const [id, r] of Object.entries(parent.Resources)) if (!['AWS::Lambda::Function', 'AWS::Lambda::Version', 'AWS::Lambda::Permission', 'AWS::ApiGatewayV2::Integration'].includes(r.Type))
    assert.deepEqual(t.Resources[id], r, id);
  for (const [key, value] of Object.entries(parent.Rules)) assert.deepEqual(t.Rules[key], value);
  for (const [key, value] of Object.entries(parent.Conditions)) if (!['Qualification', 'ArtifactMatches'].includes(key)) assert.deepEqual(t.Conditions[key], value);
  assert.deepEqual(t.Resources.Integration.Properties.IntegrationUri, { Ref: 'Published' });
  for (const r of Object.values(t.Resources)) if (r.Type === 'AWS::Lambda::Permission') assert.deepEqual(r.Properties.FunctionName, { Ref: 'Published' });
  const p = parameters(t);
  assert.equal(evaluate(t.Conditions.Qualification, t, p), summary.sourceClean);
  assert.equal(evaluate(t.Conditions.Active, t, p), false);
  // Independent conditional-logic fixture with a CLEAN source declaration.
  // Otherwise a dirty local build would mask every missing-review negative.
  // This is not a clean compiled artifact or an executed review claim.
  const cleanTemplate = successorProviderTemplate(parent, { ...summary, sourceClean: true }, name,
    json(name, 'artifact-manifest.json').packages[0].lambdaCodeSha256).template;
  const cleanParameters = { ...parameters(cleanTemplate), SourceClean: 'true' };
  assert.equal(evaluate(cleanTemplate.Conditions.Qualification, cleanTemplate, cleanParameters), true);
  for (const [k, v] of Object.entries({ SourceClean: 'false', SourceInputSha256: '4'.repeat(64), MigrationReleaseSha256: '4'.repeat(64),
    MigrationAssemblySha256: '4'.repeat(64), SuccessorQualificationProfile: 'adopted-plan-inventory-qualification/1',
    DatabaseName: 'clinical_core', 'AWS::AccountId': '173535830222', 'AWS::Region': 'us-west-2', QualificationExecution: 'disabled' }))
    assert.equal(evaluate(cleanTemplate.Conditions.Qualification, cleanTemplate, { ...cleanParameters, [k]: v }), false, k);
  for (const key of Object.keys(t.Parameters).filter(key => /ReviewSha256$/.test(key)))
    assert.equal(evaluate(cleanTemplate.Conditions.Qualification, cleanTemplate, { ...cleanParameters, [key]: '' }), false, key);
  const vars = t.Resources.Function.Properties.Environment.Variables;
  assert.deepEqual(vars.SUCCESSOR_QUALIFICATION_PROFILE, { Ref: 'SuccessorQualificationProfile' });
  assert.deepEqual(vars.MIGRATION_ASSEMBLY_SHA256, { Ref: 'MigrationAssemblySha256' });
  if (name === 'telehealth-consent') { assert.equal(t.Parameters.ConsentEnabled.Default, 'false'); assert.equal(json(name, 'artifact-manifest.json').configurationIdentityContract, 'telehealth-consent-configuration/2'); }
});
for (const name of ['telehealth-consent', 'clinic-records']) test(`${name} actual packaged entry refuses before AWS transport and detects environment drift`, () => {
  const file = join(directory, name, 'index.js');
  const invoke = `const m=require(${JSON.stringify(file)});async function run(){let r=await m.handler({});if(r.statusCode!==503||r.headers?.['x-clinical-execution'])process.exit(2);process.env.CLINICAL_DATABASE_SECRET_ARN='arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-operator-X';r=await m.handler({});if(r.statusCode!==503||r.headers?.['x-clinical-execution'])process.exit(3)}run().catch(()=>process.exit(4));`;
  execFileSync(process.execPath, ['-e', invoke], { encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, QUALIFICATION_EXECUTION: 'disabled', PHI_ALLOWED: 'false' } });
});
test('successor configuration tool produces only a digest and refuses historical, extra, malformed or secret inputs', () => {
  const t = json('telehealth-consent', 'template.json'), p = { ...parameters(t), QualificationExecution: 'disabled',
    OrganizationId: '11111111-1111-4111-8111-111111111111', ConsumerIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Consumer',
    WorkforceIssuer: 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Workforce', ConsumerAudience: 'c'.repeat(26), WorkforceAudience: 'w'.repeat(26),
    DatabaseClusterArn: 'arn:aws:rds:us-east-2:588966314750:cluster:fictional',
    DatabaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/runtime-api-fictional-AbCd12' };
  for (const key of Object.keys(t.Parameters)) if (key.endsWith('Sha256') && !p[key].match(/^[a-f0-9]{64}$/)) p[key] = '3'.repeat(64);
  const environment = { AWS_REGION: 'us-east-2', ...Object.fromEntries(Object.entries(t.Resources.Function.Properties.Environment.Variables)
    .filter(([key]) => key !== 'TELEHEALTH_CONSENT_CONFIGURATION_SHA256').map(([key, value]) => [key, evaluate(value, t, p)])) };
  const input = { contract: 'telehealth-consent-configuration/2', environment }, file = join(directory, 'telehealth-consent', 'configuration-identity.cjs');
  const result = spawnSync(process.execPath, [file], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['configurationSha256']);
  assert.match(JSON.parse(result.stdout).configurationSha256, /^[a-f0-9]{64}$/); assert.equal(result.stderr, '');
  for (const bad of [{ ...input, contract: 'telehealth-consent-configuration/1' }, { ...input, environment: { ...environment, secret: 'DO-NOT-ECHO' } },
    { ...input, environment: { ...environment, MIGRATION_ASSEMBLY_SHA256: '4'.repeat(64) } },
    { ...input, environment: { ...environment, PHI_ALLOWED: 'true' } }, { ...input, environment: { ...environment, CLINICAL_DATABASE_NAME: 'clinical_core' } },
    { ...input, environment: { ...environment, CLINICAL_DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-X' } }]) {
    const refused = spawnSync(process.execPath, [file], { input: JSON.stringify(bad), encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.equal(refused.stderr, 'successor_telehealth_consent_configuration_input_refused\n');
  }
  const oversized = spawnSync(process.execPath, [file], { input: JSON.stringify({ copy: 'x'.repeat(20001) }), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(oversized.status, 1); assert.equal(oversized.stdout, '');
});
test('template helper refuses a missing mapped function, bad publication hash and unknown kind', () => {
  const parent = json('telehealth-consent', 'historical-builder', 'template.json'), identity = { sourceCommit: summary.sourceCommit,
    sourceInputSha256: summary.sourceInputSha256, sourceClean: summary.sourceClean }, hash = json('telehealth-consent', 'artifact-manifest.json').packages[0].lambdaCodeSha256;
  assert.throws(() => successorProviderTemplate(parent, identity, 'other', hash));
  assert.throws(() => successorProviderTemplate(parent, identity, 'telehealth-consent', 'stale'));
  const missing = structuredClone(parent); delete missing.Resources.Function;
  assert.throws(() => successorProviderTemplate(missing, identity, 'telehealth-consent', hash));
});
