import { mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/chat-transcription";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: ["src/server/clinical-core/aws-chat-transcription-lambda.ts"],
  outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22",
  format: "cjs", minify: false, sourcemap: false, legalComments: "none", treeShaking: true,
});
console.log(`AWS chat transcription artifact built at ${outdir}/index.js.`);
