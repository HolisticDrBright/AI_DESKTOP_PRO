import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
if (process.argv.length !== 2) throw new Error('care_message_upgrade_argument_invalid');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const directory = 'dist/aws-clinical-core/care-messaging-schema-upgrade';
mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/care-messaging-schema-upgrade-operator.ts'], outfile: `${directory}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __CARE_MESSAGING_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }) } });
writeFileSync(`${directory}/artifact-manifest.json`, JSON.stringify({ contract: 'care-messaging-schema-upgrade-build/1', sourceCommit, clean,
  sha256: createHash('sha256').update(readFileSync(`${directory}/index.cjs`)).digest('hex'), phiAllowed: false, activation: 'blocked' }, null, 2) + '\n');
console.log(`Built fictional qualification-only care messaging upgrade. Clean source: ${clean}. No AWS access or migration performed.`);
