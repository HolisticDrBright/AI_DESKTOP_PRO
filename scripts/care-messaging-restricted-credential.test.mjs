import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The BLOCKED restricted-credential care-messaging artifact. It is the 112 qualification build with exactly its
 * credential boundary changed: the dedicated secret instead of any secret (including the cluster-master one), the
 * qualification database only, the restricted Lambda entry and its marker, and the reviewed SQL candidate's hashes.
 * Nothing here reaches AWS; the build writes files to a temporary directory.
 */
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const dir = mkdtempSync(join(tmpdir(), 'care-messaging-restricted-'));
const build = (...args) => execFileSync(process.execPath, ['scripts/build-aws-care-messaging.mjs', ...args], { encoding: 'utf8', timeout: 120_000 });
build('--release=112', `--out-dir=${join(dir, 'parent')}`);
build('--release=112', '--credential=restricted', `--out-dir=${join(dir, 'restricted')}`);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const parent = json(join(dir, 'parent/template.json'));
const candidate = json(join(dir, 'restricted/template.json'));
const manifest = json(join(dir, 'restricted/artifact-manifest.json'));
const parentManifest = json(join(dir, 'parent/artifact-manifest.json'));
const login = 'infra/aws-clinical-core/source-candidates/care-messaging-qualification-login.sql';
const rollback = 'infra/aws-clinical-core/source-candidates/care-messaging-qualification-login-rollback.sql';
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the restricted template is the 112 template with only its credential boundary changed', () => {
  const expected = structuredClone(parent);
  expected.Description = candidate.Description;
  expected.Metadata = candidate.Metadata;
  expected.Parameters.DatabaseClusterArn.AllowedPattern = candidate.Parameters.DatabaseClusterArn.AllowedPattern;
  expected.Parameters.DatabaseSecretArn.AllowedPattern = candidate.Parameters.DatabaseSecretArn.AllowedPattern;
  expected.Parameters.DatabaseName = candidate.Parameters.DatabaseName;
  expected.Resources.Function.Properties.Environment.Variables.CARE_MESSAGING_DATABASE_CREDENTIAL = 'restricted_qualification';
  assert.deepEqual(candidate, expected);
  assert.match(candidate.Description, /^BLOCKED /);
});

test('the secret pattern refuses the cluster-master secret and every other secret', () => {
  const pattern = new RegExp(candidate.Parameters.DatabaseSecretArn.AllowedPattern);
  assert.ok(pattern.test('arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-care-messaging-api-db-AbCd12'));
  for (const refused of [
    'arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-0a1b2c3d-AbCd12',
    'arn:aws:secretsmanager:us-east-2:588966314750:secret:alp-qualification-program-api-db-AbCd12',
    'arn:aws:secretsmanager:us-east-2:173535830222:secret:alp-qualification-care-messaging-api-db-AbCd12',
  ]) assert.equal(pattern.test(refused), false, refused);
  // The parent admits any secret, which is the gap this candidate closes.
  assert.ok(new RegExp(parent.Parameters.DatabaseSecretArn.AllowedPattern).test('arn:aws:secretsmanager:us-east-2:588966314750:secret:rds!cluster-0a1b2c3d-AbCd12'));
  assert.deepEqual(candidate.Parameters.DatabaseName, { Type: 'String', AllowedValues: ['clinical_core_qualification'] });
  assert.deepEqual(candidate.Parameters.PhiAllowed.AllowedValues, ['false']);
  assert.deepEqual(candidate.Parameters.Activation.AllowedValues, ['blocked']);
});

test('the template and manifest pin the reviewed SQL candidate and claim no deployment', () => {
  assert.equal(candidate.Metadata.ClinicalCore.SqlCandidateSha256, sha(read(login)));
  assert.equal(candidate.Metadata.ClinicalCore.SqlRollbackSha256, sha(read(rollback)));
  assert.equal(candidate.Metadata.ClinicalCore.Activation, 'blocked');
  assert.equal(candidate.Metadata.ClinicalCore.PhiAllowed, false);
  assert.equal(manifest.credential, 'restricted_qualification');
  assert.deepEqual(manifest.sqlCandidate, [{ path: login, sha256: sha(read(login)) }, { path: rollback, sha256: sha(read(rollback)) }]);
  assert.equal(manifest.deploymentPerformed, false);
  assert.deepEqual(manifest.defaults, { phiAllowed: false, activation: 'blocked', qualification: 'disabled' });
  assert.equal(manifest.templateSha256, sha(readFileSync(join(dir, 'restricted/template.json'))));
  assert.equal(manifest.codeSha256, sha(readFileSync(join(dir, 'restricted/index.js'))));
  assert.deepEqual(manifest.functions, parentManifest.functions);
  assert.equal(parentManifest.credential, undefined);
});

test('the restricted bundle refuses before a client exists and sends only proxy statements', () => {
  const code = readFileSync(join(dir, 'restricted/index.js'), 'utf8');
  assert.match(code, /restricted_qualification/);
  assert.match(code, /clinical_care_messaging_qualification/);
  for (const proxy of ['set_request_context($1,$2,$3,$4,$5,$6,$7)', 'request($1::jsonb) as data', 'resolve($1::jsonb) as data', 'export($1::jsonb) as data']) assert.ok(code.includes(`}.${proxy}`), proxy);
  assert.match(code, /alp-qualification-care-messaging-api-db-/);
  assert.match(code, /clinical_care_messaging_qualification_api/);
  // The default entry does not carry the restricted handler.
  assert.doesNotMatch(readFileSync(join(dir, 'parent/index.js'), 'utf8'), /restricted_qualification/);
});

test('the credential flag is refused without the 112 release or when repeated', () => {
  for (const args of [['--credential=restricted'], ['--release=112', '--credential=restricted', '--credential=restricted'], ['--credential=master']]) {
    const run = spawnSync(process.execPath, ['scripts/build-aws-care-messaging.mjs', ...args, `--out-dir=${join(dir, 'refused')}`], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(run.stderr, /care_message_build_argument_invalid/);
  }
});
