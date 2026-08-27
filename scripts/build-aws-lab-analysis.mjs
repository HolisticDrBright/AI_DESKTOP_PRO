import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/lab-analysis";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/server/clinical-core/aws-lab-analysis-lambda.ts"],
    outfile: `${outdir}/api/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "none",
    logLevel: "warning",
  }),
  build({
    entryPoints: ["src/server/clinical-core/aws-lab-analysis-worker-lambda.ts"],
    outfile: `${outdir}/worker/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    legalComments: "none",
    logLevel: "warning",
  }),
]);

console.log(`AWS lab-analysis artifacts built at ${outdir}.`);
