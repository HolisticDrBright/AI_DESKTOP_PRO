/** Fixed synthetic-staging preserving operator. Build only; no AWS calls or reviews. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import {readHistoricalCareParentMigrations} from './care-canonical-migrations.mjs';
const historicalSourceOnly=process.argv.length===3&&process.argv[2]==='--historical-source-only';
if ((!historicalSourceOnly && process.argv.length !== 2)) throw new Error('care_erasure_upgrade_build_argument_invalid');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !historicalSourceOnly && !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const sha = s => createHash('sha256').update(s).digest('hex');
const load = folder => {
  const dir = `infra/aws-clinical-core/${folder}/`, manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
  if (manifest.contract_version !== 'clinical-core-migrations/1') throw new Error('care_erasure_manifest_invalid');
  return manifest.migrations.map(e => {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(e.file) || !e.file.startsWith(e.version + '_')) throw new Error('care_erasure_manifest_invalid');
    const sql = readFileSync(dir + e.file, 'utf8').replace(/\r\n?/g, '\n');
    return { version: e.version, name: e.file.slice(15, -4), sql, sha256: sha(sql) };
  });
};
const migrations = historicalSourceOnly ? readHistoricalCareParentMigrations(process.cwd()) : load('migrations');
const reference = load('catalog-migrations');
const rows = a => a.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
if (migrations.length !== 46 || reference.length !== 2
  || sha(JSON.stringify(rows(migrations))) !== '52f2027ba0db0fd570bc4714fadf5ccd39e2caabf992081cb24be56497a52017'
  || sha(JSON.stringify(rows(reference))) !== '83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62')
  throw new Error('care_erasure_embedded_history_invalid');
const directory = 'dist/aws-clinical-core/care-erasure-schema-upgrade'; mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/care-erasure-schema-upgrade-operator.ts'], outfile: `${directory}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __CARE_ERASURE_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }),
    __CARE_ERASURE_MIGRATIONS__: JSON.stringify(migrations), __CARE_ERASURE_REFERENCE_MIGRATIONS__: JSON.stringify(reference) } });
writeFileSync(`${directory}/artifact-manifest.json`, JSON.stringify({ contract: 'care-erasure-schema-upgrade-build/1', sourceCommit, clean, historicalSourceOnly,
  sha256: sha(readFileSync(`${directory}/index.cjs`)), execution: 'synthetic-staging', phiAllowed: false, migrationPerformed: false,
  sourceMigrationCount: 46, expectedLiveBefore: 46, expectedLiveAfter: 47, historicalAliasPreserved: true,
  mandatoryRollbackRehearsal: true, embeddedMigrations: true, embeddedReferenceMigrations: true, targetOverrides: false }, null, 2) + '\n');
console.log(JSON.stringify({ built: true, sourceCommit, clean, execution: 'synthetic-staging', phiAllowed: false, migrationPerformed: false }));
