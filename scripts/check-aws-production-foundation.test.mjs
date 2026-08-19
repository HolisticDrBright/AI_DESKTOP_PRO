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

const missingLogsKeyPolicy = structuredClone(production);
missingLogsKeyPolicy.Resources.ClinicalCoreKey.Properties.KeyPolicy.Statement = missingLogsKeyPolicy.Resources.ClinicalCoreKey.Properties.KeyPolicy.Statement.filter((statement) => statement.Sid !== "CloudWatchLogsEncryption");
assert(validateProductionFoundation(missingLogsKeyPolicy).some((error) => error.includes("CloudWatch Logs")));

const missingLogDependency = structuredClone(production);
delete missingLogDependency.Resources.ClinicalApiStage.DependsOn;
assert(validateProductionFoundation(missingLogDependency).some((error) => error.includes("access log destination")));

const objectLockedConfigBucket = structuredClone(production);
objectLockedConfigBucket.Resources.ConfigDeliveryBucket.Properties.ObjectLockEnabled = true;
assert(validateProductionFoundation(objectLockedConfigBucket).some((error) => error.includes("must not enable Object Lock")));

const missingConfigKms = structuredClone(production);
delete missingConfigKms.Resources.ConfigDeliveryChannel.Properties.S3KmsKeyArn;
assert(validateProductionFoundation(missingConfigKms).some((error) => error.includes("delivery must use AuditKey")));

const stalePostureVersion = structuredClone(production);
stalePostureVersion.Resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_CONTRACT_VERSION = "clinical-core/1";
assert(validateProductionFoundation(stalePostureVersion).some((error) => error.includes("posture endpoint must report clinical-core/2")));

console.log("AWS production foundation fail-closed checks passed.");
