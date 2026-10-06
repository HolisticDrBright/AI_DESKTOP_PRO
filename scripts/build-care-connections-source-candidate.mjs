/** Source-only release mapping. Cannot apply SQL, contact AWS or activate PHI. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
if (args.length > 1 || args[0] && !args[0].startsWith('--out-dir=')) throw new Error('care_connection_source_argument_invalid');
const out = resolve(args[0]?.slice('--out-dir='.length) || 'dist/aws-clinical-core/care-connections-source');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const baseline = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'], {
  encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
}));
const ledger = sha(baseline.manifest.migrations.slice(0, 104).map(m => `${m.version}:${sha(baseline.files[m.file])}`).join('\n'));
if (baseline.manifest.migrations.length !== 105 || baseline.manifest.migrations.at(-1).version !== '20261006020000'
  || ledger !== '57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0') throw new Error('care_connection_baseline_changed');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
const sql = baseline.files['20261006020000_production_care_connections.sql'];
if (sql !== readFileSync('infra/aws-clinical-core/production-candidates/care-connections.sql', 'utf8').replace(/\r\n?/g, '\n'))
  throw new Error('care_connection_reviewed_bytes_changed');
mkdirSync(out, { recursive: true });
const libraries = [];
for (const [name, entry] of [['api', 'production-care-connections-api.ts'], ['service', 'production-care-connections.ts'],
  ['upgrade', 'care-connections-schema-upgrade.ts']]) {
  const file = `${name}-library.cjs`;
  await build({ entryPoints: [`src/server/clinical-core/${entry}`], outfile: resolve(out, file),
    platform: 'node', target: 'node22', format: 'cjs', bundle: true, minify: true, legalComments: 'none' });
  libraries.push({ file, sha256: sha(readFileSync(resolve(out, file))) });
}
writeFileSync(resolve(out, 'care-connections.sql'), sql);
// Canonical source identity, not an applied/hosted release.
// Compute it from all predecessor bytes and the exact proposed overlay, then
// compare the upgrade library's independent pins rather than inventing a hash.
const plannedMigrationCount = 105;
const proposedLedger = sha(baseline.manifest.migrations.map(m => `${m.version}:${sha(baseline.files[m.file])}`).join('\n'));
const upgrade = createRequire(import.meta.url)(resolve(out, 'upgrade-library.cjs')).CARE_CONNECTIONS_UPGRADE;
if (!upgrade || upgrade.from !== ledger || upgrade.to !== proposedLedger || upgrade.version !== '20261006020000'
  || upgrade.countBefore !== 104 || upgrade.countAfter !== plannedMigrationCount) throw new Error('care_connection_upgrade_identity_changed');
const functions = [...sql.matchAll(/create(?: or replace)? function ([a-z_]+\.[a-z_]+)\([^]*?as \$\$([^]*?)\$\$/g)]
  .map(([, name, body]) => ({ name, bodySha256: sha(body), apiExecute: name.startsWith('clinical_core.') }));
if (functions.length !== 7 || new Set(functions.map(f => f.name)).size !== 7) throw new Error('care_connection_functions_invalid');
const manifest = {
  contract: 'care-connections-source-candidate/1', status: 'unreleased', deployable: false, sourceCommit, sourceDirty,
  baselineMigrationCount: 104, baselineLedgerReleaseSha256: ledger,
  baselineAssemblySha256: sha(baseline.manifest.migrations.slice(0, 104).map(m => `${m.version}:${m.file}:${sha(baseline.files[m.file])}`).join('\n')),
  canonicalAssemblySha256: baseline.releaseHash,
  proposedUpgrade: { version: upgrade.version, migrationCount: plannedMigrationCount, ledgerReleaseSha256: proposedLedger,
    canonical: true, hostedVerified: false, cliOperatorAvailable: true },
  schema: { file: 'care-connections.sql', sha256: sha(sql), bytes: Buffer.byteLength(sql) }, libraries, functions,
  proposedRoutes: ['POST /clinical-core/consumer/connection', 'POST /clinical-core/workforce/connection'],
  proposedCoveredEntityMapping: { table: 'clinical_core.care_consent_texts', scope: 'organization_column', column: 'organization_id',
    dependsOn: ['clinical_core.consent_artifacts'], appendOnly: true, status: 'inventory_integrated_disposition_blocked' },
  connectionCode: { alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', symbols: 13, entropyBits: 65, expirationHours: 24, stored: 'sha256_only' },
  activation: 'blocked', phiAllowed: false, seededApprovals: false, seededConsents: false,
  remaining: ['hosted preserving 104-prefix upgrade with rollback evidence using the bound CLI operator',
    'reviewed clinic retention/disposition procedure for the immutable copy table', 'reviewed consent-copy registration operator',
    'handler and independently reviewed deployment template', 'V2 verified text display and compare-and-set acknowledgement',
    'actual qualification JWT identities, exact-source deployment and hosted concurrent races',
    'matched mobile and Desktop releases and physical-device acceptance', 'independent security, MFA, consent and provider reviews'],
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ status: 'unreleased', deployable: false, sourceCommit, sourceDirty, baselineLedgerReleaseSha256: ledger,
  schemaSha256: manifest.schema.sha256, libraries }));
