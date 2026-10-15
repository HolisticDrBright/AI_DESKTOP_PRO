import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('clean source builds one immutable synthetic candidate and refuses the placeholder target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telehealth-qualification-build-'));
  const example = JSON.parse(readFileSync('infra/aws-clinical-core/qualification-target-connections.example.json', 'utf8'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const target = {
    ...example, sourceCommit, migrationReleaseHash: 'b'.repeat(64),
    databaseSecretArn: 'arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-secret',
    identitySubjects: {
      consumer: '51cb2580-5051-70ca-eb9c-3a3a86cd9b8a',
      workforce: '41cb4540-b031-70a6-7027-836d074e4075',
      foreignConsumer: 'e18b95e0-d021-70e8-0969-d36f36ac8e1d',
      retentionService: 'svc-qualification-b7599066',
    },
  };
  const targetPath = join(directory, 'target.json');
  const out = join(directory, 'artifact');
  writeFileSync(targetPath, JSON.stringify(target));
  const run = (path, outDir) => spawnSync(process.execPath,
    ['scripts/build-aws-telehealth-qualification.mjs', `--target=${path}`, `--out-dir=${outDir}`],
    { encoding: 'utf8', timeout: 30000 });
  const invalid = run('infra/aws-clinical-core/qualification-target-connections.example.json', out);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /telehealth_qualification_target_invalid/);

  const result = run(targetPath, out);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'artifact-manifest.json'), 'utf8'));
  const template = JSON.parse(readFileSync(join(out, 'template.json'), 'utf8'));
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(manifest.sourceCommit, sourceCommit);
  assert.equal(manifest.targetManifestSha256, digest(targetPath));
  assert.equal(manifest.codeSha256, digest(join(out, 'index.js')));
  assert.equal(manifest.deploymentZipSha256, digest(join(out, 'deployment.zip')));
  assert.equal(manifest.templateSha256, digest(join(out, 'template.json')));
  assert.equal(manifest.deployed, false);
  assert.deepEqual(template.Parameters.SourceCommit.AllowedValues, [sourceCommit]);
  assert.deepEqual(template.Resources.TelehealthFunction.Properties.Code.S3ObjectVersion, { Ref: 'LambdaCodeVersion' });
  const placeholderPreflight = spawnSync(process.execPath, ['scripts/preflight-aws-telehealth-qualification.mjs',
    `--artifact-dir=${out}`, '--target=infra/aws-clinical-core/qualification-target-connections.example.json',
    '--version-id=fictional-version', '--profile=fictional-profile'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(placeholderPreflight.status, 1);
  assert.match(placeholderPreflight.stderr, /telehealth_qualification_preflight_target_refused/);
  assert.equal(run(targetPath, out).status, 1, 'an existing artifact is never overwritten');
});
