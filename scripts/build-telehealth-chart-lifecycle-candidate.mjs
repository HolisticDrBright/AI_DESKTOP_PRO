/** Source-only forward candidate (113). Never applies SQL, deploys, or creates approvals or transfers. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telehealthChartLifecycleCandidate } from './telehealth-chart-lifecycle-candidate.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('telehealth_chart_lifecycle_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-copy-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true }));
const sql = readFileSync(resolve(root, 'infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql'), 'utf8').replace(/\r\n?/g, '\n');
const result = telehealthChartLifecycleCandidate(parent, sql), { manifest, files } = result;
if (json) process.stdout.write(JSON.stringify(result));
else {
  const out = resolve(root, 'dist/aws-clinical-core/telehealth-chart-lifecycle-candidate');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(out, name), content);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify(result.candidate, null, 2) + '\n');
  process.stdout.write('Built distinct 113-migration telehealth chart/lifecycle candidate; all 112 parent files unchanged. No deployment or activation.\n');
}
