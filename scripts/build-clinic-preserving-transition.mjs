/** Builds blocked source transition data only. No AWS transport or operator. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildClinicPreservingTransition, CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from './clinic-preserving-transition.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.slice(2).join(',') !== '' && process.argv.slice(2).join(',') !== '--json')
  throw Error('clinic_preserving_transition_arguments_refused');
const bytes = readFileSync(new URL('../infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== CLINIC_NATIVE_SOURCE_RECEIPT_SHA256)
  throw Error('clinic_native_source_receipt_bytes_refused');
const artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
const plan = buildClinicPreservingTransition(artifact, JSON.parse(bytes.toString('utf8')));
if (process.argv.includes('--json')) console.log(JSON.stringify(plan));
else {
  const directory = new URL('../dist/aws-clinical-core/clinic-preserving-transition/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL('source-transition.json', directory), JSON.stringify(plan, null, 2) + '\n');
  console.log('Built exact 112-to-116 source transition: 217 historical tables, 11 empty new tables required. No operator, registration, AWS or activation.');
}
