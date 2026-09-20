import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/retention-service-release-operator";
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/retention-service-release-operator.ts"],
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

console.log(`Retention service release operator built at ${outdir}/index.cjs.`);
