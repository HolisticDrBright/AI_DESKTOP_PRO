import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualificationConsentArtifact, QUALIFICATION_CONSENT_LEDGER } from './qualification-consent-ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw new Error('Usage: build-adopted-plan-inventory-candidate.mjs [--json]');
const sha = value => createHash('sha256').update(value).digest('hex');
// Validate the COMPLETE historical parent with the unchanged historical gate.
// Never widen that gate or pass this successor off as a 106-migration release.
const baseline = JSON.parse(execFileSync(process.execPath, ['scripts/build-aws-production-clinical-core.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000, windowsHide: true }));
qualificationConsentArtifact(baseline);
const file = '20261009010000_production_adopted_plan_inventory.sql';
const sql = readFileSync(resolve(root, 'infra/aws-clinical-core/production-candidates/owned-plan-inventory.sql'), 'utf8').replace(/\r\n?/g, '\n');
if (/\b(synthetic|supabase|auth\.|fly|app\s*runner)\b/i.test(sql) || !sql.trim()) throw new Error('inventory_candidate_invalid');
const manifest = { ...baseline.manifest, migrations: [...baseline.manifest.migrations, { version: '20261009010000', file }] };
const files = { ...baseline.files, [file]: sql };
const migrationReleaseSha256 = sha(manifest.migrations.map(m => `${m.version}:${sha(files[m.file])}`).join('\n'));
const releaseHash = sha(manifest.migrations.map(m => `${m.version}:${m.file}:${sha(files[m.file])}`).join('\n'));
const artifact = { manifest, files, releaseHash, candidate: {
  contract: 'adopted-plan-inventory-candidate/1', parentMigrationCount: 106, parentMigrationReleaseSha256: QUALIFICATION_CONSENT_LEDGER,
  migrationCount: 107, migrationReleaseSha256, extensionSha256: sha(sql),
  deployment: 'not_deployed', activation: 'blocked', phiAllowed: false,
} };
if (json) process.stdout.write(JSON.stringify(artifact));
else {
  const out = resolve(root, 'dist/aws-clinical-core/adopted-plan-inventory-candidate');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify(artifact.candidate, null, 2));
  process.stdout.write(`Built distinct 107-migration inventory candidate (${migrationReleaseSha256}); historical parent unchanged; no deployment or activation.\n`);
}
