import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import { validateProductionFoundation } from "./check-aws-production-foundation.mjs";

const source = JSON.parse(readFileSync(resolve("infra/aws-clinical-core/template.json"), "utf8"));
const production = buildProductionFoundation(source);

assert.deepEqual(validateProductionFoundation(production), []);

const enabled = structuredClone(production);
enabled.Outputs.PhiAllowed.Value = "true";
assert(validateProductionFoundation(enabled).some((error) => error.includes("PhiAllowed")));

const appRunner = structuredClone(production);
appRunner.Resources.ForbiddenRuntime = { Type: "AWS::AppRunner::Service", Properties: {} };
assert(validateProductionFoundation(appRunner).some((error) => error.includes("App Runner")));

const supabase = structuredClone(production);
supabase.Parameters.LegacyUrl = { Type: "String", Default: "https://example.supabase.co" };
assert(validateProductionFoundation(supabase).some((error) => error.includes("Supabase")));

console.log("AWS production foundation fail-closed checks passed.");
