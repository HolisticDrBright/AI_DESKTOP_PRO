/** Build only. No AWS calls, migration execution, review or activation. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
if (process.argv.length !== 2) throw new Error('adopted_inventory_upgrade_argument_invalid');
const sha = value => createHash('sha256').update(value).digest('hex');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 }));
const migrations = artifact.manifest.migrations.map(m => ({
  version: m.version, name: m.file.slice(15, -4), sql: artifact.files[m.file], sha256: sha(artifact.files[m.file]),
}));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const out = 'dist/aws-clinical-core/adopted-plan-inventory-upgrade';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/adopted-plan-inventory-schema-upgrade-operator.ts'], outfile: `${out}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __ADOPTED_INVENTORY_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }),
    __ADOPTED_INVENTORY_MIGRATIONS__: JSON.stringify(migrations) } });
await build({ entryPoints: ['src/server/clinical-core/adopted-plan-inventory-interruption-worker.ts'], outfile: `${out}/interruption-worker.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __ADOPTED_INVENTORY_UPGRADE_BUILD__: JSON.stringify({ sourceCommit, clean }),
    __ADOPTED_INVENTORY_MIGRATIONS__: JSON.stringify(migrations) } });
writeFileSync(`${out}/artifact-manifest.json`, JSON.stringify({
  contract: 'adopted-plan-inventory-upgrade-build/1', sourceCommit, clean,
  operatorSha256: sha(readFileSync(`${out}/index.cjs`)), embeddedMigrationCount: migrations.length,
  interruptionWorkerSha256: sha(readFileSync(`${out}/interruption-worker.cjs`)),
  fromReleaseSha256: artifact.candidate.parentMigrationReleaseSha256, toReleaseSha256: artifact.candidate.migrationReleaseSha256,
  execution: 'qualification_only', phiAllowed: false, activation: 'blocked', migrationPerformed: false,
  mandatoryRollbackRehearsal: true, postRehearsalPrestateRecheck: true, automaticWriteRetry: false,
  durableNativeCustody: true, sharedOperatorNamespace: true, readOnlyInterruptionReconciliation: true,
  reconciliationRequiresMigrationLocks: true, hostedRecoveryQualified: false,
  interruptionWorkerScope: 'instrumented_real_core_and_ports_before_write_and_precommit_only',
}, null, 2) + '\n');
console.log(`Built separate inventory upgrade operator. Clean source: ${clean}. No AWS call or migration performed.`);
