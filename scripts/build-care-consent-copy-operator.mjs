/** Builds a qualification-only copy registrar. No AWS access or approval. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
if (process.argv.length !== 2) throw new Error('care_consent_copy_build_arguments_invalid');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const directory = 'dist/aws-clinical-core/care-consent-copy-registration';
mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/care-consent-copy-operator.ts'], outfile: `${directory}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, legalComments: 'none', sourcemap: false,
  define: { __CARE_CONSENT_COPY_BUILD__: JSON.stringify({ sourceCommit, clean }) } });
writeFileSync(`${directory}/artifact-manifest.json`, JSON.stringify({ contract: 'care-consent-copy-build/1', sourceCommit, clean,
  sha256: createHash('sha256').update(readFileSync(`${directory}/index.cjs`)).digest('hex'),
  execution: 'qualification_only', phiAllowed: false, activation: 'blocked', approvalCreated: false, grantCreated: false,
  mandatoryRollbackRehearsal: true }, null, 2) + '\n');
console.log(`Built qualification-only consent-copy registrar. Clean source: ${clean}. No AWS access or registration.`);
