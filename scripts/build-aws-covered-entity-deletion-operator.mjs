import { mkdirSync,readFileSync } from "node:fs";
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import { build } from "esbuild";

const args=process.argv.slice(2);
if(args.length>1 || (args[0] && !args[0].startsWith('--out-dir=')))throw new Error('covered_entity_build_argument_refused');
const outdir = resolve(args[0]?.slice('--out-dir='.length) || "dist/aws-clinical-core/covered-entity-deletion-operator");
// Validate the actual schema mapping before sealing it into the operator.
execFileSync(process.execPath,['scripts/check-aws-covered-entity-coverage.mjs'],{stdio:'inherit',timeout:30000});
const coverage=readFileSync('infra/aws-clinical-core/covered-entity-coverage.json','utf8').replace(/\r\n?/g,'\n');
const digest=createHash('sha256').update(coverage).digest('hex');
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/covered-entity-deletion-operator.ts"],
  outfile: `${outdir}/index.cjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  define:{__COVERED_ENTITY_COVERAGE_BYTES__:JSON.stringify(coverage),__COVERED_ENTITY_COVERAGE_SHA256__:JSON.stringify(digest)},
  logLevel: "warning",
});

console.log(`Covered entity deletion operator built at ${outdir}/index.cjs.`);
