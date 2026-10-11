/** Source-only builder. No AWS clients, schema writes, review or activation. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telehealthRequestAuthorityCandidate } from './telehealth-request-authority-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('telehealth_request_authority_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-transfer-authority-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const source = readFileSync(resolve(root, 'infra/aws-clinical-core/source-candidates/telehealth-request-authority.sql'), 'utf8');
const result = telehealthRequestAuthorityCandidate(parent, source);
if (json) process.stdout.write(JSON.stringify(result));
else {
  const directory = resolve(root, 'dist/aws-clinical-core/telehealth-request-authority-candidate-v1');
  mkdirSync(directory, { recursive: true });
  for (const [name, sql] of Object.entries(result.files)) writeFileSync(resolve(directory, name), sql);
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(result.candidate, null, 2) + '\n');
  process.stdout.write('Built blocked 118 source candidate; exact 117 parent bytes preserved. No apply, runtime admission or activation.\n');
}
