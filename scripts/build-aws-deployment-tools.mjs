import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/deployment-tools";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: {
    operator: "src/server/clinical-core/aws-deployment-cli.ts",
    acceptance: "src/server/clinical-core/aws-acceptance-cli.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

console.log(`AWS deployment tools built at ${outdir}.`);
