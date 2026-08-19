import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf8");
const errors = [];
const assert = (condition, message) => { if (!condition) errors.push(message); };

const packageJson = JSON.parse(read("package.json"));
const fixture = JSON.parse(read("infra/aws-clinical-core/synthetic-acceptance-manifest.example.json"));
const migration = read("src/server/clinical-core/migrations.ts");
const database = read("src/server/clinical-core/rds-data-database.ts");
const provisioner = read("src/server/clinical-core/synthetic-fixtures.ts");
const acceptance = read("src/server/clinical-core/synthetic-acceptance.ts");
const powershell = read("scripts/apply-aws-synthetic-data.ps1");
const identityProvisioning = read("scripts/provision-aws-synthetic-identities.ps1");
const ignore = read(".gitignore");

assert(packageJson.scripts?.["build:aws-deployment-tools"] === "node scripts/build-aws-deployment-tools.mjs", "deployment-tools build script must be pinned");
assert(packageJson.scripts?.["check:aws-deployment-acceptance"] === "node scripts/check-aws-deployment-acceptance.mjs", "deployment check script must be pinned");
assert(ignore.includes("/infra/aws-clinical-core/synthetic-acceptance-manifest.json"), "reviewed fixture manifest must remain ignored");
assert(fixture.environment === "synthetic-staging" && fixture.dataClassification === "synthetic_only" && fixture.containsPhi === false, "fixture example must be synthetic-only");
assert(!/(email|phone|password|token|authorization|cookie)/i.test(JSON.stringify(fixture)), "fixture example must not contain contacts, credentials, or tokens");
assert(migration.includes("splitPostgresStatements") && migration.includes("for (const [index, statement] of statements.entries())") && migration.includes("await tx.query(statement)"), "Data API migration runner must execute one parsed statement at a time");
assert(database.includes("reviewed_synthetic_migration") && database.includes('createRdsDataDatabase(configuration, client, "clinical_core_api")')
  && database.includes("if (assumeRole)"), "administrative and request database paths must remain explicit");
assert(provisioner.includes("hasExactKeys") && provisioner.includes("fixture_mismatch") && !provisioner.includes("on conflict (id) do update"), "fixtures must be exact, immutable, and mismatch-refusing");
assert(acceptance.includes('redirect: "manual"') && acceptance.includes("AbortSignal.timeout(15_000)"), "acceptance transport must refuse redirects and have a hard timeout");
assert(acceptance.includes("patientName: \"refused\"") && acceptance.includes("isolationWorkforceIdToken") && acceptance.includes("externalRequests: 30")
  && acceptance.includes("/clinical-core/workforce/posture") && acceptance.includes("/clinical-core/consumer/posture")
  && acceptance.includes("scope: \"lab_results_import\"") && acceptance.includes("duplicateImport")
  && acceptance.includes("/clinical-core/workforce/lab-imports/review")
  && acceptance.includes("/clinical-core/consumer/patient-labs")
  && acceptance.includes("/clinical-core/consumer/records")
  && acceptance.includes("/clinical-core/consumer/privacy/consents")
  && acceptance.includes("/clinical-core/consumer/privacy/requests"),
"acceptance must test both identity bridges, PHI-shaped and cross-tenant refusal, scoped consents, duplicate-safe clinical and lab imports, privacy requests, review, and read-back across all thirty operations");
assert(identityProvisioning.includes("labConsentArtifactId") && identityProvisioning.includes("protocolConsentArtifactId")
  && identityProvisioning.includes("nutritionConsentArtifactId") && identityProvisioning.includes("symptomsConsentArtifactId")
  && identityProvisioning.includes("formsConsentArtifactId") && identityProvisioning.includes("syncProviderId"),
  "synthetic identity reprovisioning must preserve every governed consent and provider fixture field");
assert(!acceptance.includes("console.") && !provisioner.includes("console."), "clinical acceptance modules must not log tokens, subjects, or payloads");
assert(powershell.includes("ConfirmSyntheticOnly") && powershell.includes("aws sts get-caller-identity") && powershell.includes("Remove-Item Env:CLINICAL_DATABASE_SECRET_ARN"), "operator script must confirm posture, pin account, and clear identifiers");

if (errors.length) {
  errors.forEach((error) => console.error(`AWS deployment acceptance check failed: ${error}`));
  process.exitCode = 1;
} else {
  console.log("AWS deployment acceptance check passed: single-statement migration, exact synthetic fixtures, and bounded token-in-memory workflow.");
}
