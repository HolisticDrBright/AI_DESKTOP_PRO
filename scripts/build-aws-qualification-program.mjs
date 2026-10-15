import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

// A candidate bundle must name exactly the committed source it was built from.
// Build only from a clean checkout; no run-time SOURCE_COMMIT value can stand in for this check.
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
if (dirty.trim()) throw new Error('qualification_program_build_dirty_checkout');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('qualification_program_source_identity_invalid');

const outdir = 'dist/aws-clinical-core/qualification-program';
mkdirSync(outdir, { recursive: true });
const outfile = `${outdir}/index.cjs`;
await build({
  entryPoints: ['src/server/clinical-core/aws-qualification-program-lambda.ts'],
  outfile, bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  minify: false, sourcemap: false, legalComments: 'none', treeShaking: true,
  define: { __QUALIFICATION_PROGRAM_SOURCE_COMMIT__: JSON.stringify(sourceCommit) },
  logLevel: 'warning',
});
const bundleSha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex');
writeFileSync(`${outdir}/build-identity.json`, `${JSON.stringify({
  contract: 'qualification-program-bundle/1', sourceCommit,
  boundaryCandidateSha256: JSON.parse(readFileSync('infra/aws-clinical-core/source-candidates/qualification-program-boundary.json', 'utf8')).successor.sha256,
  bundleSha256,
}, null, 2)}\n`);
console.log(`BLOCKED qualification program bundle built from ${sourceCommit}; no deployment or activation performed.`);
