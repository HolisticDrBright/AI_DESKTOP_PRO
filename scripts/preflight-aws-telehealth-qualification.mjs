/** Read-only AWS preflight. This never uploads code, creates a stack or activates a provider. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { verifyTelehealthQualificationPreflight } from './telehealth-qualification-preflight.mjs';

const args = process.argv.slice(2);
const names = ['artifact-dir', 'target', 'version-id', 'profile'];
if (args.length !== names.length || args.some(a => !names.some(n => a.startsWith(`--${n}=`)))
  || names.some(n => args.filter(a => a.startsWith(`--${n}=`)).length !== 1))
  throw new Error('telehealth_qualification_preflight_argument_invalid');
const arg = name => args.find(a => a.startsWith(`--${name}=`)).slice(name.length + 3);
const out = resolve(arg('artifact-dir'));
const targetPath = resolve(arg('target'));
const versionId = arg('version-id');
const profile = arg('profile');
if (!profile || !versionId || versionId === 'null') throw new Error('telehealth_qualification_preflight_argument_invalid');
const read = name => readFileSync(join(out, name));
const artifact = JSON.parse(read('artifact-manifest.json').toString('utf8'));
const templateBytes = read('template.json');
const template = JSON.parse(templateBytes.toString('utf8'));
const codeBytes = read('index.js'), localZipBytes = read('deployment.zip');
const targetBytes = readFileSync(targetPath), target = JSON.parse(targetBytes.toString('utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
if (dirty || sourceCommit !== artifact.sourceCommit) throw new Error('telehealth_qualification_preflight_source_refused');
try {
  execFileSync(process.execPath, ['scripts/check-aws-qualification-target.mjs', targetPath],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
} catch { throw new Error('telehealth_qualification_preflight_target_refused'); }

const aws = (...parts) => {
  const result = spawnSync('aws', [...parts, '--region', 'us-east-2', '--profile', profile, '--output', 'json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('telehealth_qualification_preflight_aws_unavailable');
  return JSON.parse(result.stdout);
};
const caller = aws('sts', 'get-caller-identity');
if (caller.Account !== '588966314750'
  || !/^arn:aws:sts::588966314750:assumed-role\//.test(caller.Arn ?? ''))
  throw new Error('telehealth_qualification_preflight_caller_refused');
const foundation = aws('cloudformation', 'describe-stacks', '--stack-name', target.foundationStackName).Stacks?.[0];
const f = Object.fromEntries((foundation?.Outputs ?? []).map(row => [row.OutputKey, row.OutputValue]));
if (!f.CodeBucket) throw new Error('telehealth_qualification_preflight_foundation_refused');
const api = aws('apigatewayv2', 'get-api', '--api-id', target.apiId);
const versioning = aws('s3api', 'get-bucket-versioning', '--bucket', f.CodeBucket);
const objectHead = aws('s3api', 'head-object', '--bucket', f.CodeBucket,
  '--key', artifact.codeKey, '--version-id', versionId);
if (objectHead.ContentLength !== localZipBytes.length || objectHead.VersionId !== versionId)
  throw new Error('telehealth_qualification_preflight_code_refused');

const stackName = 'ai-clinical-core-qualification-telehealth-requests';
const stack = spawnSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', stackName,
  '--region', 'us-east-2', '--profile', profile, '--output', 'json'], { encoding: 'utf8', timeout: 30000 });
const stackAbsent = stack.status !== 0 && !stack.error && /ValidationError/.test(stack.stderr)
  && /does not exist/.test(stack.stderr);
if (!stackAbsent) throw new Error('telehealth_qualification_preflight_stack_refused');

const temporary = mkdtempSync(join(tmpdir(), 'telehealth-code-read-'));
const downloaded = join(temporary, 'deployment.zip');
let downloadedZipBytes, rebuilt;
try {
  const rebuiltDir = join(temporary, 'rebuilt');
  execFileSync(process.execPath, ['scripts/build-aws-telehealth-qualification.mjs',
    `--target=${targetPath}`, `--out-dir=${rebuiltDir}`],
  { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  rebuilt = JSON.parse(readFileSync(join(rebuiltDir, 'artifact-manifest.json'), 'utf8'));
  // The S3 version, not an unversioned latest object, is the only accepted input.
  const get = spawnSync('aws', ['s3api', 'get-object', '--bucket', f.CodeBucket, '--key', artifact.codeKey,
    '--version-id', versionId, '--region', 'us-east-2', '--profile', profile, '--output', 'json', downloaded],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (get.status !== 0 || get.error) throw new Error('telehealth_qualification_preflight_code_unavailable');
  downloadedZipBytes = readFileSync(downloaded);
} finally {
  const inside = relative(resolve(tmpdir()), resolve(temporary));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('telehealth_qualification_temp_path_refused');
  rmSync(temporary, { recursive: true, force: true });
}

const report = verifyTelehealthQualificationPreflight({ artifact, template, target, targetBytes, templateBytes,
  codeBytes, localZipBytes, downloadedZipBytes, versionId, sourceCommit, caller, foundation, api,
  versioning, objectHead, stackAbsent, rebuilt });
process.stdout.write(JSON.stringify(report) + '\n');
