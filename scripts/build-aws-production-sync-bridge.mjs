import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/production-sync-bridge";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
await build({ entryPoints: ["scripts/sync/aws-production-bridge-handler.mjs"], outfile: `${outdir}/index.cjs`,
  bundle: true, platform: "node", target: "node22", format: "cjs", legalComments: "none", logLevel: "warning" });
console.log(`Production AWS sync bridge candidate built at ${outdir}/index.cjs; activation remains blocked.`);

