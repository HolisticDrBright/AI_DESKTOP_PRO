import { beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Artifact = { manifest: { migrations: { version: string; file: string }[] }; files: Record<string, string>; releaseHash: string };
const build = 'scripts/build-aws-production-clinical-core.mjs';
const output = resolve('dist/aws-clinical-core/production-migrations');
const run = promisify(execFile);
let parallel: Artifact[];

beforeAll(async () => {
  // Exercise the actual CLI in parallel, not a substitute SQL fixture/compiler.
  parallel = await Promise.all([0, 1].map(async () => {
    const result = await run(process.execPath, [build, '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as Artifact;
  }));
  execFileSync(process.execPath, [build], { stdio: 'pipe', timeout: 10000 });
}, 20000);

describe('isolated canonical production migration artifact', () => {
  it('produces identical complete manifests and SQL from concurrent builders', () => {
    expect(parallel[0]).toEqual(parallel[1]);
    expect(parallel[0].manifest.migrations).toHaveLength(97);
    expect(Object.keys(parallel[0].files)).toHaveLength(97);
    expect(parallel[0].manifest.migrations.at(-1)?.file).toBe('20260920150000_production_owned_privacy_export_retention_ops.sql');
  });
  it('matches the normal release files byte for byte and verifies the release digest', () => {
    const artifact = parallel[0];
    expect(JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'))).toEqual(artifact.manifest);
    for (const entry of artifact.manifest.migrations) {
      expect(readFileSync(resolve(output, entry.file), 'utf8')).toBe(artifact.files[entry.file]);
    }
    const digest = createHash('sha256').update(artifact.manifest.migrations.map(({ version, file }) =>
      `${version}:${file}:${createHash('sha256').update(artifact.files[file]).digest('hex')}`).join('\n')).digest('hex');
    expect(digest).toBe(artifact.releaseHash);
  });
});
