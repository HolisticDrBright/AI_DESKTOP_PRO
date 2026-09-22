import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/model-vendor-authority-operator";
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/model-vendor-authority-operator.ts"],
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

console.log(`Model vendor authority operator built at ${outdir}/index.cjs.`);
