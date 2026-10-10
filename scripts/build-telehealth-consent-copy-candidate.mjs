/** Source-only forward candidate. Never applies SQL or creates approvals. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telehealthConsentCopyCandidate } from './telehealth-consent-copy-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('telehealth_consent_copy_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-fullscript-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true }));
const sql = readFileSync(resolve(root, 'infra/aws-clinical-core/production-candidates/telehealth-consent-copy.sql'), 'utf8').replace(/\r\n?/g, '\n');
const result = telehealthConsentCopyCandidate(parent, sql), { manifest, files } = result;
if (json) process.stdout.write(JSON.stringify(result));
else {
  const out = resolve(root, 'dist/aws-clinical-core/telehealth-consent-copy-candidate');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify(result.candidate, null, 2) + '\n');
  process.stdout.write('Built distinct 112-migration telehealth exact-copy candidate; all parents unchanged. No deployment or activation.\n');
}
