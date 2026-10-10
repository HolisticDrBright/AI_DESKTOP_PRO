import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULLSCRIPT_EXTENSIONS, fullscriptCandidate } from './fullscript-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = process.argv.length === 3 && process.argv[2] === '--json';
if (process.argv.length > 2 && !json) throw Error('fullscript_candidate_argument_refused');
const parent = JSON.parse(execFileSync(process.execPath, ['scripts/build-telehealth-consent-candidate.mjs', '--json'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true }));
const sources = Object.fromEntries(FULLSCRIPT_EXTENSIONS.map(e => [e.source,
  readFileSync(resolve(root, `infra/aws-clinical-core/source-candidates/${e.source}.sql`), 'utf8')]));
const artifact = fullscriptCandidate(parent, sources);
if (json) process.stdout.write(JSON.stringify(artifact));
else {
  const out = resolve(root, 'dist/aws-clinical-core/fullscript-candidate');
  mkdirSync(out, { recursive: true });
  for (const [file, sql] of Object.entries(artifact.files)) writeFileSync(resolve(out, file), sql);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(artifact.manifest, null, 2) + '\n');
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify(artifact.candidate, null, 2) + '\n');
  process.stdout.write(`Built distinct 111-migration blocked candidate (${artifact.candidate.migrationReleaseSha256}); 106/107/108 unchanged. No deployment or activation.\n`);
}
