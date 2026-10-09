import { mkdirSync } from "node:fs";
import { build } from "esbuild";

const outdir = "dist/aws-clinical-core/chat-transcription";
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: ["src/server/clinical-core/aws-chat-transcription-lambda.ts"],
  outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22",
  format: "cjs", minify: false, sourcemap: false, legalComments: "none", treeShaking: true,
});
console.log(`AWS chat transcription artifact built at ${outdir}/index.js.`);
await build({ entryPoints: ["src/server/clinical-core/aws-voice-jobs-lambda.ts"], outfile: `${outdir}/jobs/index.js`,
  bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false, legalComments: "none" });
console.log(`Durable voice-job artifact built at ${outdir}/jobs/index.js.`);
await build({ entryPoints: ["src/server/clinical-core/voice-watch-backfill-cli.ts"], outfile: `dist/aws-clinical-core/voice-watch-backfill/backfill.cjs`,
  bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false, legalComments: "none" });
console.log(`Synthetic-only voice cleanup backfill operator built (not executed).`);
