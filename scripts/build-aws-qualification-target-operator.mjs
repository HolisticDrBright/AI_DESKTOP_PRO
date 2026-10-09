import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/qualification-target-operator";
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/qualification-target-operator.ts"],
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

console.log(`Qualification target operator built at ${outdir}/index.cjs.`);
