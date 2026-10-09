import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const outdir = "dist/aws-clinical-core/consumer-account";
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: ["src/server/clinical-core/aws-consumer-account-lambda.ts"],
  outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22",
  format: "cjs", sourcemap: false, minify: true,
});
