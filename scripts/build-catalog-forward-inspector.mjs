// Source-only builder. Embeds exact registered histories and pending SQL; no
// AWS calls, migration, activation, credentials or patient-content capture.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import {readCanonicalCareMigrations,readHistoricalCatalogParentMigrations} from './care-canonical-migrations.mjs';
const rehearsal = process.argv.length === 3 && process.argv[2] === '--rollback-rehearsal';
const apply = process.argv.length === 3 && process.argv[2] === '--preserving-apply';
if (process.argv.length !== 2 && !rehearsal && !apply) throw new Error('catalog_forward_build_argument_invalid');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const clean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'scripts', 'infra', 'package.json', 'package-lock.json', '.gitattributes', '.github'], { encoding: 'utf8' }).trim();
function load(folder) {
  const root = `infra/aws-clinical-core/${folder}/`, manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'));
  if (manifest.contract_version !== 'clinical-core-migrations/1' || !Array.isArray(manifest.migrations)) throw new Error('catalog_forward_manifest_invalid');
  return manifest.migrations.map(entry => {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(entry.file) || !entry.file.startsWith(entry.version + '_')) throw new Error('catalog_forward_manifest_invalid');
    const sql = readFileSync(root + entry.file, 'utf8').replace(/\r\n?/g, '\n');
    return { version: entry.version, name: entry.file.slice(15, -4), sha256: sha(sql), sql };
  });
}
readCanonicalCareMigrations(process.cwd());
const core = load('migrations'), reference = readHistoricalCatalogParentMigrations(process.cwd());
const sql = readFileSync('infra/aws-clinical-core/source-candidates/catalog-offer-current-product.sql', 'utf8').replace(/\r\n?/g, '\n');
const candidate = { version: '20261008060000', name: 'catalog_offer_current_product', sha256: sha(sql), sql };
const rows = entries => entries.map(({ version, name, sha256 }) => ({ version, name, sha256 }));
if (core.length !== 47 || sha(JSON.stringify(rows(core))) !== '02026932fff5a37db42a17a1c4f80bd38a759cf8e2ccb2f4d53b8299c66065e7'
  || reference.length !== 2 || sha(JSON.stringify(rows(reference))) !== '83d51dc056b41f47b5fb3d6020201163915faa2116004e3692af9bb41aad0f62'
  || candidate.sha256 !== '3d63f4a04b8168818844736ea5143115ca1e01fc9b2c96f0da6d5889938a6117') throw new Error('catalog_forward_artifact_invalid');
const directory = 'dist/aws-clinical-core/' + (apply ? 'catalog-forward-apply' : rehearsal ? 'catalog-forward-rollback' : 'catalog-forward-inspector'); mkdirSync(directory, { recursive: true });
await build({ entryPoints: ['src/server/clinical-core/' + (rehearsal || apply ? 'catalog-forward-rehearsal-database.ts' : 'catalog-forward-inspection-operator.ts')], outfile: `${directory}/index.cjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __CATALOG_FORWARD_BUILD__: JSON.stringify({ sourceCommit, clean, ...(apply ? {lastingApplyAvailable:true} : {}) }), __CATALOG_FORWARD_CORE__: JSON.stringify(core),
    __CATALOG_FORWARD_REFERENCE__: JSON.stringify(reference), __CATALOG_FORWARD_CANDIDATE__: JSON.stringify(candidate) } });
writeFileSync(`${directory}/artifact-manifest.json`, JSON.stringify({ contract: apply ? 'catalog-forward-apply-build/1' : rehearsal ? 'catalog-forward-rollback-build/1' : 'catalog-forward-inspector-build/1', sourceCommit, clean,
  sha256: sha(readFileSync(`${directory}/index.cjs`)), execution: 'synthetic-staging', phiAllowed: false,
  coreSourceCount: 47, coreLiveCount: 48, referenceBeforeCount: 2, referenceCandidateCount: 3,
  referenceBeforeSha256: sha(JSON.stringify(rows(reference))), referenceCandidateSha256: sha(JSON.stringify([...rows(reference), ...rows([candidate])])),
  candidateSqlSha256: candidate.sha256, readOnly: !rehearsal && !apply, rollbackRehearsalAvailable: rehearsal || apply, lockAdmissionQualificationAvailable: rehearsal || apply, lastingApplyAvailable: apply,
  canonicalRegistered: false, databaseMutationPerformed: false, hostedAcceptance: false, activationApproved: false }, null, 2) + '\n');
console.log(JSON.stringify({ built: true, sourceCommit, clean, readOnly: !rehearsal && !apply, databaseMutationPerformed: false }));
