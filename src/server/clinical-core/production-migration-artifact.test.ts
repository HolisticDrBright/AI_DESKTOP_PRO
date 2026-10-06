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
    expect(parallel[0].manifest.migrations).toHaveLength(105);
    expect(Object.keys(parallel[0].files)).toHaveLength(105);
    expect(parallel[0].manifest.migrations.at(-1)?.file).toBe('20261006020000_production_care_connections.sql');
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
  it('keeps the exact historic 104 prefix and admits only the reviewed canonical successor bytes', () => {
    const artifact = parallel[0];
    const ledger = (entries: typeof artifact.manifest.migrations) => createHash('sha256').update(entries.map(({ version, file }) =>
      `${version}:${createHash('sha256').update(artifact.files[file]).digest('hex')}`).join('\n')).digest('hex');
    expect(ledger(artifact.manifest.migrations.slice(0, 104))).toBe('57fdf022f0fdd7d70be12384d6e6d54caab1a0ddb4965a884e4d59eec4c552b0');
    expect(ledger(artifact.manifest.migrations)).toBe('7da8e4ed999a3298bccc4ef33e7a1005201db45fa2b46682622a208486f17743');
    const sql = artifact.files['20261006020000_production_care_connections.sql'];
    expect(sql).toBe(readFileSync('infra/aws-clinical-core/production-candidates/care-connections.sql', 'utf8').replace(/\r\n?/g, '\n'));
    expect(createHash('sha256').update(sql).digest('hex')).toBe('0ade0879e0a5b5468461249d8dd39ffd8ea64fa51860e21af6a55cfc256642c5');
  });
});
