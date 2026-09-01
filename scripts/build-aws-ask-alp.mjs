import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/ask-alp";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/server/clinical-core/aws-ask-alp-lambda.ts"],
  outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22", format: "cjs", legalComments: "none", logLevel: "warning",
});
console.log(`AWS Ask ALP artifact built at ${outdir}.`);
