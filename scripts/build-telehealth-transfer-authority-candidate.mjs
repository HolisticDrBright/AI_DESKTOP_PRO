/** Source-only 117 candidate; never applies SQL or registers authority. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telehealthTransferAuthorityCandidate } from './telehealth-transfer-authority-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('telehealth_authority_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const source = readFileSync(resolve(root, 'infra/aws-clinical-core/source-candidates/telehealth-transfer-authority.sql'), 'utf8');
const result = telehealthTransferAuthorityCandidate(parent, source);
if (json) process.stdout.write(JSON.stringify(result));
else {
  const directory = resolve(root, 'dist/aws-clinical-core/telehealth-transfer-authority-candidate-v2');
  mkdirSync(directory, { recursive: true });
  for (const [name, sql] of Object.entries(result.files)) writeFileSync(resolve(directory, name), sql);
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(result.candidate, null, 2) + '\n');
  process.stdout.write('Built blocked 117 source candidate; exact 116 parent bytes preserved. No apply, deployment or activation.\n');
}
