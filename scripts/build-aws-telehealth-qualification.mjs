/** Build only. The reviewed target and live AWS configuration still require an independent preflight. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { careMessagingZip } from './care-messaging-zip.mjs';
import { telehealthQualificationTemplate } from './telehealth-qualification-template.mjs';

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || args.some(a => !/^--(target|out-dir)=.+$/.test(a))
  || args.filter(a => a.startsWith('--target=')).length !== 1
  || args.filter(a => a.startsWith('--out-dir=')).length > 1) throw new Error('telehealth_qualification_build_argument_invalid');
const arg = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
if (dirty) throw new Error('telehealth_qualification_source_dirty');
// Reuse the same strict target validator as the other qualification runners;
// the telehealth-specific checks below add source/API pins and closed providers.
try {
  execFileSync(process.execPath, ['scripts/check-aws-qualification-target.mjs', resolve(arg('target'))],
    { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
} catch { throw new Error('telehealth_qualification_target_invalid'); }
const targetBytes = readFileSync(resolve(arg('target')));
const target = JSON.parse(targetBytes.toString('utf8'));
const base = JSON.parse(readFileSync('infra/aws-clinical-core/telehealth-requests-extension.json', 'utf8'));
const template = telehealthQualificationTemplate(base, target, sourceCommit);
const out = resolve(arg('out-dir') ?? `dist/aws-clinical-core/telehealth-qualification-${sourceCommit}`);
if (existsSync(out)) throw new Error('telehealth_qualification_output_exists');
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/aws-telehealth-requests-lambda.ts'], outfile: `${out}/index.js`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'none', logLevel: 'warning' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const code = readFileSync(`${out}/index.js`);
const zip = careMessagingZip(code);
const templateBytes = Buffer.from(JSON.stringify(template, null, 2) + '\n');
writeFileSync(`${out}/deployment.zip`, zip);
writeFileSync(`${out}/template.json`, templateBytes);
writeFileSync(`${out}/artifact-manifest.json`, JSON.stringify({
  contract: 'telehealth-qualification-deployment/1', dataClassification: 'synthetic_only', containsPhi: false,
  sourceCommit, sourceClean: true, awsAccountId: target.awsAccountId, awsRegion: target.awsRegion,
  apiId: target.apiId, databaseName: target.databaseName, migrationReleaseHash: target.migrationReleaseHash,
  targetManifestSha256: sha(targetBytes), codeSha256: sha(code), deploymentZipSha256: sha(zip),
  templateSha256: sha(templateBytes), deploymentZipBytes: zip.length,
  codeKey: `telehealth-qualification/${sourceCommit}/deployment.zip`,
  providerFlags: { zoom: false, reminders: false, stripeTest: false },
  deployed: false, hostedVerified: false, phiApproved: false,
  remaining: ['verify live target and immutable S3 version', 'deploy a new qualification stack only',
    'verify Lambda CodeSha256 and stack identity', 'run fictional hosted negative and race cases'],
}, null, 2) + '\n');
console.log(`Built synthetic-only telehealth qualification artifact at ${out}; nothing deployed.`);
