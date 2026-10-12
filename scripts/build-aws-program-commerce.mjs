import { build } from "esbuild";
import { mkdirSync } from "node:fs";

// Two functions, two roles: the consumer education API (API session only) and the scheduled worker (worker and delivery sessions).
for (const [name, entry] of [["education-api", "src/server/commerce/reviewed/education-api-lambda.ts"], ["commerce-worker", "src/server/commerce/reviewed/commerce-worker-lambda.ts"]]) {
  const outdir = `dist/aws-clinical-core/program-commerce/${name}`;
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22",
    format: "cjs", sourcemap: false, minify: true,
  });
}
