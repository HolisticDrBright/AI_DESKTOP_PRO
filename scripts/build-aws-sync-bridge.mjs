import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/sync-bridge";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["scripts/sync/aws-bridge-handler.mjs"],
  outfile: `${outdir}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  legalComments: "none",
  logLevel: "warning",
});

console.log(`AWS sync-bridge artifact built at ${outdir}.`);
