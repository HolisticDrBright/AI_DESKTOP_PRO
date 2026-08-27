import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(new URL(
  "../infra/aws-clinical-core/production-clinical-api-disabled.json", import.meta.url), "utf8"));
const candidate = JSON.parse(readFileSync(new URL(
  "../infra/aws-clinical-core/production-clinical-api-candidate.json", import.meta.url), "utf8"));
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };
const serialized = JSON.stringify(template);
const resources = Object.values(template.Resources ?? {});
const role = template.Resources?.ProductionClinicalApiRole;
const fn = template.Resources?.ProductionClinicalApiFunction;
const handler = readFileSync(new URL("../src/server/clinical-core/aws-production-clinical-api.ts", import.meta.url), "utf8");
const identityHandler = readFileSync(new URL("../src/server/clinical-core/aws-identity-api.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../src/server/clinical-core/aws-production-clinical-lambda.ts", import.meta.url), "utf8");
const pilotPolicy = readFileSync(new URL("../src/server/clinical-core/production-pilot-policy.ts", import.meta.url), "utf8");
const candidateResources = Object.values(candidate.Resources ?? {});
const candidateRole = candidate.Resources?.ProductionClinicalApiRole;
const candidateFunction = candidate.Resources?.ProductionClinicalApiFunction;
const expectedRoutes = new Set([
  "GET /clinical-core/workforce/posture",
  "GET /clinical-core/consumer/posture",
  "POST /clinical-core/workforce/invitations",
  "POST /clinical-core/consumer/invitations/claim",
  "POST /clinical-core/workforce/consents/grant",
  "POST /clinical-core/consumer/consents/grant",
  "POST /clinical-core/workforce/consents/revoke",
  "POST /clinical-core/consumer/consents/revoke",
  "GET /clinical-core/consumer/consent-artifact",
  "POST /clinical-core/consumer/labs/import",
  "GET /clinical-core/consumer/connection",
  "GET /clinical-core/workforce/lab-imports",
  "POST /clinical-core/workforce/lab-imports/review",
  "GET /clinical-core/workforce/patient-labs",
  "GET /clinical-core/consumer/patient-labs",
  "POST /clinical-core/consumer/records",
  "GET /clinical-core/consumer/records",
  "GET /clinical-core/consumer/privacy/consents",
  "POST /clinical-core/consumer/privacy/requests",
  "GET /clinical-core/consumer/privacy/requests",
  "POST /clinical-core/workforce/data-compatibility",
]);

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
assert(handler.includes('activationState === "approved"') && handler.includes("activationEvidenceSha256")
  && handler.includes('get("custom:production_bound") !== "true"'),
"candidate API must require approved evidence and an immutable production-bound identity");
assert(identityHandler.includes("createAwsProductionIdentityApiHandler")
  && identityHandler.includes('claim(claims, "custom:production_bound") !== "true"')
  && identityHandler.includes('claim(claims, "custom:synthetic_attested") === "true"')
  && identityHandler.includes('environment: "production-clinical"')
  && identityHandler.includes('containsPhi: true'),
"candidate App/Desktop API must bind both identity planes to the production PHI context");
assert(identityHandler.includes("isProductionPilotRouteAllowed")
  && identityHandler.includes("isProductionPilotDesktopRequestAllowed")
  && identityHandler.includes("pilotOrganizationId"),
"candidate App/Desktop API must enforce route, operation, and organization pilot scope");
for (const forbiddenPilotCapability of [
  "book_appointment", "send_message", "start_card_payment", "activate_protocol_version",
]) {
  assert(!pilotPolicy.includes(`\"${forbiddenPilotCapability}\"`),
    `pilot policy must refuse ${forbiddenPilotCapability}`);
}
for (const requiredPilotCapability of [
  "create_sync_invitation", "set_sync_consent_scope", "list_patient_lab_observations",
  "get_patient_app_intake", "list_review_queue", "resolve_review_queue_item",
]) {
  assert(pilotPolicy.includes(`\"${requiredPilotCapability}\"`),
    `pilot policy is missing ${requiredPilotCapability}`);
}
assert(runtime.includes('required("PHI_ALLOWED") === "true"')
  && runtime.includes('required("ACTIVATION_STATE")')
  && runtime.includes('required("PILOT_SCOPE")')
  && runtime.includes('required("CLINICAL_CONSUMER_ISSUER")')
  && runtime.includes('required("CLINICAL_CONSUMER_AUDIENCE")')
  && runtime.includes("createAwsProductionIdentityConsentAdapter")
  && runtime.includes("createAwsProductionClinicalStateAdapter")
  && runtime.includes("createAwsProductionConsumerClinicalRecordsAdapter"),
"candidate runtime must read both activation gates and use production App/Desktop adapters");

assert(candidate.Metadata?.ClinicalCore?.Environment === "production-clinical"
  && candidate.Metadata?.ClinicalCore?.DefaultPhiAllowed === false,
"candidate template must default to the closed production boundary");
assert(candidate.Parameters?.PhiAllowed?.Default === "false"
  && candidate.Parameters?.ActivationState?.Default === "blocked"
  && candidate.Parameters?.ActivationEvidenceSha256?.Default === ""
  && candidate.Parameters?.PilotScope?.Default === "lab_intake_only"
  && candidate.Parameters?.PilotOrganizationId?.Default === "00000000-0000-0000-0000-000000000000",
"candidate activation parameters must default to blocked with no evidence");
assert(candidate.Rules?.ActivationMustBeCoherent && candidate.Rules?.BlockedStateCannotCarryEvidence
  && candidate.Rules?.ActivationRequiresNamedPilotOrganization
  && candidate.Conditions?.DataPlaneEnabled,
"candidate must have independent coherent-activation rules and a data-plane condition");
assert(candidateFunction?.Properties?.Environment?.Variables?.PHI_ALLOWED?.Ref === "PhiAllowed"
  && candidateFunction.Properties.Environment.Variables.ACTIVATION_STATE?.Ref === "ActivationState"
  && candidateFunction.Properties.Environment.Variables.ACTIVATION_EVIDENCE_SHA256?.Ref === "ActivationEvidenceSha256"
  && candidateFunction.Properties.Environment.Variables.PILOT_SCOPE?.Ref === "PilotScope"
  && candidateFunction.Properties.Environment.Variables.PILOT_ORGANIZATION_ID?.Ref === "PilotOrganizationId"
  && candidateFunction.Properties.Environment.Variables.SOURCE_VERSION?.Ref === "SourceVersion",
"candidate function must receive every activation and provenance gate");
const candidatePolicies = candidateRole?.Properties?.Policies ?? [];
assert(candidatePolicies.length === 3
  && candidatePolicies[0]?.PolicyName === "BoundedEncryptedLoggingOnly"
  && candidatePolicies.slice(1).every((policy) => policy?.["Fn::If"]?.[0] === "DataPlaneEnabled"),
"candidate data permissions must exist only behind DataPlaneEnabled");
const candidateRoutes = candidateResources.filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
assert(candidateRoutes.length === expectedRoutes.size
  && candidateRoutes.every((route) => expectedRoutes.has(route.Properties?.RouteKey))
  && new Set(candidateRoutes.map((route) => route.Properties?.RouteKey)).size === expectedRoutes.size,
"candidate must expose exactly the 21 reviewed routes, without wildcard routes");
assert(candidateRoutes.every((route) => route.Properties?.AuthorizationType === "JWT"),
"every candidate route must require JWT authorization");
const candidateSerialized = JSON.stringify(candidate).toLowerCase();
for (const forbidden of ["supabase", "fly.dev", "aws_access_key_id", "aws_secret_access_key"]) {
  assert(!candidateSerialized.includes(forbidden), `candidate contains forbidden provider/credential marker: ${forbidden}`);
}

if (errors.length) {
  errors.forEach((error) => console.error(`ERROR: ${error}`));
  process.exit(1);
}
console.log("Production clinical API gates passed: deployed boundary is PHI-disabled/log-only; candidate is one-organization lab/intake pilot scoped with 21 JWT routes and conditionally absent data permissions.");
