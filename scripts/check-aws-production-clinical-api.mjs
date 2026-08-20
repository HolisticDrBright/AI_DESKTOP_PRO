import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(new URL(
  "../infra/aws-clinical-core/production-clinical-api-disabled.json", import.meta.url), "utf8"));
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };
const serialized = JSON.stringify(template);
const resources = Object.values(template.Resources ?? {});
const role = template.Resources?.ProductionClinicalApiRole;
const fn = template.Resources?.ProductionClinicalApiFunction;

assert(template.Metadata?.ClinicalCore?.Environment === "production-clinical", "environment marker missing");
assert(template.Metadata?.ClinicalCore?.DataClassification === "clinical_phi_target", "classification marker missing");
assert(template.Metadata?.ClinicalCore?.PhiAllowed === false, "metadata must keep PHI disabled");
assert(template.Parameters?.PhiAllowed?.AllowedValues?.length === 1
  && template.Parameters.PhiAllowed.AllowedValues[0] === "false", "PhiAllowed must be structurally pinned false");
assert(fn?.Properties?.Environment?.Variables?.PHI_ALLOWED?.Ref === "PhiAllowed", "function PHI boundary is missing");
assert(fn?.Properties?.Environment?.Variables?.ACTIVATION_STATE === "blocked", "activation must remain blocked");
assert(fn?.Properties?.Code?.ZipFile?.includes("statusCode: 503"), "function must return HTTP 503");
assert(fn?.Properties?.Code?.ZipFile?.includes("production_not_activated"), "bounded refusal code missing");
assert(fn?.Properties?.Timeout === 5 && fn?.Properties?.MemorySize === 128,
  "disabled boundary compute must remain short-lived and minimal");
assert(resources.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Authorizer").length === 2,
  "both workforce and consumer Cognito authorizers are required");
assert(resources.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route").every(
  (resource) => resource.Properties?.AuthorizationType === "JWT"), "every production clinical route must require JWT");
assert(role?.Properties?.Policies?.length === 1
  && role.Properties.Policies[0]?.PolicyName === "BoundedEncryptedLoggingOnly", "disabled function may only log");
for (const forbidden of [
  "DatabaseSecretArn", "DatabaseClusterArn", "secretsmanager:GetSecretValue", "rds-data:",
  "supabase", "fly.dev", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
]) assert(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `forbidden capability present: ${forbidden}`);

if (errors.length) {
  errors.forEach((error) => console.error(`ERROR: ${error}`));
  process.exit(1);
}
console.log("Production clinical API disabled-boundary gate passed: JWT required, PHI false, zero data-plane permissions.");
