import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";

// The three campaign Lambdas, each its own artifact. They bundle only src/campaigns: nothing clinical is reachable.
for (const name of ["api", "sender", "events"]) {
  const outdir = `dist/campaigns/${name}`;
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: [`src/campaigns/lambda/${name}.ts`], outfile: `${outdir}/index.js`, bundle: true, platform: "node", target: "node22",
    format: "cjs", minify: false, sourcemap: false, legalComments: "none", treeShaking: true, logLevel: "warning",
    alias: { "@": "./src" },
  });
  console.log(`Campaign ${name} artifact built at ${outdir}/index.js.`);
}
