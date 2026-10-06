/** Builds an exact-source qualification-only operator. No AWS requests. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
if (process.argv.length !== 2) throw new Error('care_connections_upgrade_argument_invalid');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const directory = 'dist/aws-clinical-core/care-connections-schema-upgrade';
mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/care-connections-schema-upgrade-operator.ts'], outfile: `${directory}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __CARE_CONNECTIONS_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }) } });
writeFileSync(`${directory}/artifact-manifest.json`, JSON.stringify({ contract: 'care-connections-schema-upgrade-build/1',
  sourceCommit, clean, sha256: createHash('sha256').update(readFileSync(`${directory}/index.cjs`)).digest('hex'),
  phiAllowed: false, activation: 'blocked', execution: 'qualification_only', migrationPerformed: false,
  mandatoryRollbackRehearsal: true }, null, 2) + '\n');
console.log(`Built qualification-only care connections upgrade. Clean source: ${clean}. No AWS access or migration performed.`);
