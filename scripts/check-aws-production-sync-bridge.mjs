import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync("infra/aws-clinical-core/production-sync-bridge-candidate.json", "utf8"));
const source = readFileSync("scripts/sync/aws-production-bridge-handler.mjs", "utf8");
const resources = template.Resources;
const errors = [];
const assert = (value, message) => { if (!value) errors.push(message); };
assert(template.Parameters.PhiAllowed.Default === "false", "PHI must default false");
assert(template.Parameters.ActivationState.Default === "blocked", "activation must default blocked");
assert(resources.SyncWorkerSchedule.Properties.State["Fn::If"][2] === "DISABLED", "schedule must default disabled");
assert(resources.SyncBridgeSecret.Properties.SecretString === '{"configured":false}', "disabled secret must contain no credentials");
assert(template.Parameters.OrganizationId.Default === "00000000-0000-4000-8000-000000000000"
  && template.Parameters.V2BaseUrl.Default === "https://disabled.invalid", "disabled provider placeholders changed");
assert(resources.SyncBridgeRole.Properties.Policies.length === 2, "worker role policy shape changed");
assert(JSON.stringify(resources.SyncBridgeRole).includes("DataPlaneEnabled"), "data access is not activation-gated");
assert(JSON.stringify(resources.SyncBridgeRole).includes("rds-data:BeginTransaction"), "Aurora transaction permission missing");
assert(resources.SyncApiLogGroup.Properties.RetentionInDays === 365 && resources.SyncWorkerLogGroup.Properties.RetentionInDays === 365, "sync logs must retain 365 days");
for (const marker of ["set local role clinical_sync_worker", "production_not_activated", "verifyCallback", "register_sync_callback_nonce", "record_sync_lab_result", "runCycle"]) {
  assert(source.includes(marker), `runtime missing ${marker}`);
}
assert(!/supabase/i.test(source), "production runtime contains a Supabase dependency");
if (errors.length) { errors.forEach((error) => console.error(`ERROR: ${error}`)); process.exit(1); }
execFileSync(process.execPath, ["scripts/build-aws-production-sync-bridge.mjs"], { stdio: "inherit" });
const artifact = readFileSync("dist/aws-clinical-core/production-sync-bridge/index.cjs", "utf8");
assert(!/supabaseServiceRoleKey|SYNC_SUPABASE_URL/.test(artifact), "production artifact contains a Supabase credential path");
if (errors.length) { errors.forEach((error) => console.error(`ERROR: ${error}`)); process.exit(1); }
console.log("Production AWS sync bridge gate passed: HMAC callback, worker-only DB role, activation-gated IAM, disabled schedule, and no Supabase runtime dependency.");
