/** Source-only successor proposal. No AWS calls, SQL execution or registration. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zoomHostAuthorityCandidate } from './zoom-host-authority-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('zoom_host_authority_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-chart-lifecycle-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const source = readFileSync(resolve(root, 'infra/aws-clinical-core/source-candidates/zoom-host-authority.sql'), 'utf8');
const result = zoomHostAuthorityCandidate(parent, source);
if (json) process.stdout.write(JSON.stringify(result));
else {
  const out = resolve(root, 'dist/aws-clinical-core/zoom-host-authority-candidate');
  mkdirSync(out, { recursive: true });
  const allowed = new Set([...Object.keys(result.files), 'manifest.json', 'candidate.json', 'function-pins.json']);
  // Refuse stale/mixed output instead of overwriting an unrelated file or shipping it.
  if (readdirSync(out).some(name => !allowed.has(name))) throw Error('zoom_host_authority_output_refused');
  for (const [name, content] of Object.entries(result.files)) writeFileSync(resolve(out, name), content);
  for (const [name, value] of [['manifest.json', result.manifest], ['candidate.json', result.candidate], ['function-pins.json', result.functionPins]]) {
    writeFileSync(resolve(out, name), JSON.stringify(value, null, 2) + '\n');
  }
  process.stdout.write('Built blocked 114-migration Zoom host authority proposal; exact 113 parent preserved. No apply, registration, deployment or activation.\n');
}
