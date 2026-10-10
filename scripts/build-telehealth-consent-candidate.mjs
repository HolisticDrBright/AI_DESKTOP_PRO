import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('telehealth_consent_build_argument_refused');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ledger = artifact => sha(artifact.manifest.migrations.map(m => m.version + ':' + sha(artifact.files[m.file])).join('\n'));
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-adopted-plan-inventory-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true }));
const parentHash = '542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c';
if (parent.manifest?.migrations?.length !== 107 || ledger(parent) !== parentHash
  || parent.candidate?.activation !== 'blocked' || parent.candidate?.phiAllowed !== false) throw Error('telehealth_consent_parent_refused');
const file = '20261009100000_production_telehealth_recording_consent.sql';
const sql = readFileSync(resolve(root, 'infra/aws-clinical-core/production-candidates/telehealth-recording-consent.sql'), 'utf8').replace(/\r\n?/g, '\n');
if (!sql.trim() || /\b(synthetic|supabase|auth\.|fly|app\s*runner)\b/i.test(sql)
  || /\b(insert|update|delete|grant)\s+/i.test(sql.replace(/--[^\n]*/g, ''))) throw Error('telehealth_consent_extension_refused');
const manifest = { ...parent.manifest, migrations: [...parent.manifest.migrations, { version: '20261009100000', file }] };
const files = { ...parent.files, [file]: sql };
const artifact = { manifest, files,
  releaseHash: sha(manifest.migrations.map(m => m.version + ':' + m.file + ':' + sha(files[m.file])).join('\n')),
  candidate: { contract: 'telehealth-consent-candidate/1', parentMigrationCount: 107,
    parentMigrationReleaseSha256: parentHash, migrationCount: 108, migrationReleaseSha256: ledger({ manifest, files }),
    extensionSha256: sha(sql), deployment: 'not_deployed', activation: 'blocked', phiAllowed: false } };
if (json) process.stdout.write(JSON.stringify(artifact));
else {
  const out = resolve(root, 'dist/aws-clinical-core/telehealth-consent-candidate');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify(artifact.candidate, null, 2) + '\n');
  process.stdout.write('Built distinct 108-migration telehealth consent candidate; 106/107 unchanged. No deployment or activation.\n');
}
