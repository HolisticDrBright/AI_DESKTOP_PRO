import { mkdirSync } from "node:fs";
import { build } from "esbuild";
mkdirSync("dist/qualification", { recursive: true });
await build({ entryPoints: ["src/server/clinical-core/security-qualification-cli.ts"], outfile: "dist/qualification/security-qualification.cjs",
  bundle: true, platform: "node", target: "node22", format: "cjs", legalComments: "none", logLevel: "warning" });
console.log("Security qualification harness built; nothing was run or deployed.");
