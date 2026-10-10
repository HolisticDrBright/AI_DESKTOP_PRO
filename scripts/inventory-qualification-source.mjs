import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
const paths = ['src', 'scripts', 'infra', 'data', 'package.json', 'package-lock.json', '.gitattributes', '.gitignore', '.github'];
const sha = v => createHash('sha256').update(v).digest('hex');
/** Before/after source-byte observation, NOT an atomic filesystem snapshot. */
export function inventorySourceIdentity() {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...paths], { encoding: 'utf8' }).trim();
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean).sort();
  const entries = [...new Set(names)].map(name => {
    const before = lstatSync(name); if (!before.isFile() || before.isSymbolicLink()) throw Error('inventory_source_file_refused');
    const bytes = readFileSync(name), after = lstatSync(name);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) throw Error('inventory_build_source_changed');
    return `${name}:${sha(bytes)}`;
  });
  return { sourceCommit, sourceClean, sourceInputSha256: sha(entries.join('\n')) };
}
