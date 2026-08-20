import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/production-clinical-api";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/aws-production-clinical-lambda.ts"],
  outfile: `${outdir}/index.cjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  logLevel: "warning",
});

console.log(`Production clinical API candidate built at ${outdir}/index.cjs; deployment remains blocked.`);
