import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { inventorySourceIdentity } from './inventory-qualification-source.mjs';
if (process.argv.length !== 2) throw Error('fictional_mapping_build_argument_refused');
const source = inventorySourceIdentity();
if (!source.sourceClean) throw Error('fictional_mapping_clean_source_required');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
const out = resolve('dist/aws-clinical-core/inventory-qualification-identity-mapping'); mkdirSync(out, { recursive: true });
const rows = artifact.manifest.migrations.map(m => ({ version: m.version, sha256: createHash('sha256').update(artifact.files[m.file].replace(/\r\n?/g, '\n')).digest('hex') }));
await build({ stdin: { contents: `import {runFictionalInventoryMapping} from './src/server/clinical-core/inventory-qualification-identity-mapping-cli';\nvoid runFictionalInventoryMapping(${JSON.stringify(rows)},${JSON.stringify(source.sourceCommit)});`,
  resolveDir: process.cwd(), sourcefile: 'inventory-identity-mapping-entry.ts', loader: 'ts' }, outfile: resolve(out, 'index.cjs'),
bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, legalComments: 'none' });
if (JSON.stringify(source) !== JSON.stringify(inventorySourceIdentity())) throw Error('fictional_mapping_source_changed');
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ contract: 'inventory-qualification-identity-mapping-build/1', ...source,
  operatorSha256: createHash('sha256').update(readFileSync(resolve(out, 'index.cjs'))).digest('hex'),
  migrationCount: rows.length, migrationReleaseSha256: createHash('sha256').update(rows.map(r => `${r.version}:${r.sha256}`).join('\n')).digest('hex'),
  account: '588966314750', region: 'us-east-2', qualificationDatabase: 'clinical_core_qualification',
  deployed: false, databaseIdentityAuthorityVerified: false, consentReleasesWritten: 0, providerReleasesWritten: 0,
  acceptance: false, phiAllowed: false, activation: 'blocked' }, null, 2)+'\n');
console.log('Built identity-only fictional mapping operator; no AWS call or approval.');
