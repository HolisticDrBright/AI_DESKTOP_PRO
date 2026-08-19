import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAwsDataPlaneMigration } from "./check-aws-data-plane-migration.mjs";

function project() {
  const root = mkdtempSync(join(tmpdir(), "aws-migration-gate-"));
  for (const directory of ["src", "app", "backend", "lib"]) mkdirSync(join(root, directory), { recursive: true });
  return root;
}

const cleanDesktop = project();
const cleanApp = project();
writeFileSync(join(cleanDesktop, "src", "adapter.ts"), "export const dataPlane = 'aurora';\n");
writeFileSync(join(cleanApp, "backend", "api.ts"), "export const runtime = 'ecs_fargate';\n");
assert.equal(scanAwsDataPlaneMigration({ desktop: cleanDesktop, app: cleanApp }).ready, true);

writeFileSync(join(cleanApp, "backend", "legacy.ts"), "const url = process.env.SUPABASE_URL;\n");
const blocked = scanAwsDataPlaneMigration({ desktop: cleanDesktop, app: cleanApp });
assert.equal(blocked.ready, false);
assert.deepEqual(blocked.blockers.map((item) => item.rule), ["supabase_saas_runtime"]);

writeFileSync(join(cleanApp, "backend", "legacy.test.ts"), "const ignored = 'example.fly.dev';\n");
assert.equal(scanAwsDataPlaneMigration({ desktop: cleanDesktop, app: cleanApp }).blockers.length, 1);
console.log("AWS data-plane migration gate checks passed.");
