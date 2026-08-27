import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const foundationPath = fileURLToPath(new URL("../infra/aws-clinical-core/template.json", import.meta.url));
const extensionPath = fileURLToPath(new URL("../infra/aws-clinical-core/catalog-api-extension.json", import.meta.url));

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

function actions(statement) {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

export function validateGovernedCatalogApi(foundation, extension) {
  const errors = [];
  const base = foundation.Resources ?? {};
  const resources = extension.Resources ?? {};
  const metadata = extension.Metadata?.ClinicalCore ?? {};
  assert(errors, metadata.ContractVersion === "governed-catalog-api/1", "catalog API contract must be pinned");
  assert(errors, metadata.EnvironmentMode === "parameterized-isolated-account" && metadata.DataClassification === "reference_only", "catalog API must remain isolated-account reference-only");
  assert(errors, metadata.ContainsPhi === false && metadata.RealPatientDataAllowed === false, "catalog API must refuse PHI and real-patient mode");
  assert(errors, JSON.stringify(extension.Parameters?.EnvironmentName?.AllowedValues) === JSON.stringify(["synthetic-staging", "production-clinical"]), "catalog environment must be explicitly bounded");
  assert(errors, base.ClinicalDatabaseCluster?.Properties?.EnableHttpEndpoint === true, "Aurora Data API must remain enabled");

  const routes = Object.values(resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Route");
  const expected = new Set([
    "GET /clinical-core/workforce/catalog/products",
    "GET /clinical-core/consumer/catalog/products",
    "GET /clinical-core/workforce/catalog/protocol-templates",
  ]);
  assert(errors, routes.length === expected.size, "catalog extension must expose exactly three routes");
  for (const route of routes) {
    assert(errors, expected.delete(route.Properties?.RouteKey), "catalog route is unexpected or duplicated");
    assert(errors, route.Properties?.AuthorizationType === "JWT" && route.Properties?.AuthorizerId, "every catalog route must require JWT authorization");
  }
  assert(errors, expected.size === 0, "one or more catalog routes are missing");

  for (const name of ["WorkforceCatalogJwtAuthorizer", "ConsumerCatalogJwtAuthorizer"]) {
    const authorizer = resources[name]?.Properties;
    assert(errors, authorizer?.AuthorizerType === "JWT", `${name} must be JWT`);
    assert(errors, JSON.stringify(authorizer?.IdentitySource) === JSON.stringify(["$request.header.Authorization"]), `${name} must read only Authorization`);
    assert(errors, authorizer?.JwtConfiguration?.Issuer && authorizer?.JwtConfiguration?.Audience?.length === 1, `${name} must pin issuer and audience`);
  }

  const fn = resources.CatalogApiFunction?.Properties;
  assert(errors, fn?.Runtime === "nodejs22.x" && fn?.Architectures?.[0] === "arm64", "catalog Lambda runtime must be bounded");
  assert(errors, fn?.Timeout === 15 && fn?.MemorySize === 256 && !fn?.VpcConfig, "catalog Lambda must use the bounded Data API shape");
  const env = fn?.Environment?.Variables ?? {};
  assert(errors, Object.keys(env).sort().join(",") === [
    "CLINICAL_CATALOG_ENVIRONMENT", "CLINICAL_CONSUMER_AUDIENCE", "CLINICAL_CONSUMER_ISSUER", "CLINICAL_DATABASE_CLUSTER_ARN",
    "CLINICAL_DATABASE_NAME", "CLINICAL_DATABASE_SECRET_ARN", "CLINICAL_WORKFORCE_AUDIENCE",
    "CLINICAL_WORKFORCE_ISSUER",
  ].sort().join(","), "catalog Lambda environment must contain identifiers only");
  assert(errors, Object.values(env).every((value) => value && typeof value === "object"), "catalog Lambda environment must not contain literal credentials");

  const statements = (resources.CatalogApiRole?.Properties?.Policies ?? [])
    .flatMap((policy) => policy.PolicyDocument?.Statement ?? []);
  const allActions = statements.flatMap(actions);
  for (const required of [
    "rds-data:BeginTransaction", "rds-data:ExecuteStatement", "rds-data:CommitTransaction",
    "rds-data:RollbackTransaction", "secretsmanager:GetSecretValue", "kms:Decrypt",
    "logs:CreateLogStream", "logs:PutLogEvents",
  ]) assert(errors, allActions.includes(required), `IAM action ${required} is required`);
  assert(errors, allActions.every((action) => typeof action === "string" && !action.includes("*")), "IAM actions may not contain wildcards");
  assert(errors, statements.every((statement) => statement.Resource !== "*"), "IAM resources may not be global wildcards");
  assert(errors, !allActions.some((action) => action.startsWith("s3:") || action.startsWith("cognito-idp:")), "catalog request role must not administer data or identity services");

  const permission = resources.CatalogApiInvokePermission?.Properties;
  assert(errors, permission?.Principal === "apigateway.amazonaws.com", "only API Gateway may invoke the catalog Lambda");
  assert(errors, JSON.stringify(permission?.SourceArn).includes("/*/clinical-core/*"), "catalog Lambda invoke permission must be path bounded");
  assert(errors, resources.CatalogApiLogGroup?.Properties?.RetentionInDays === 30 && resources.CatalogApiLogGroup?.Properties?.KmsKeyId, "catalog logs must be encrypted and expire");
  assert(errors, resources.CatalogApiErrorAlarm?.Properties?.Threshold === 1, "first catalog Lambda error must alarm");

  const serialized = JSON.stringify(extension).toLowerCase();
  for (const forbidden of ["service_role", "requestbody", "responsebody", "email", "phone", "dateofbirth"]) {
    assert(errors, !serialized.includes(forbidden), `catalog extension contains forbidden field ${forbidden}`);
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateGovernedCatalogApi(
    JSON.parse(readFileSync(foundationPath, "utf8")),
    JSON.parse(readFileSync(extensionPath, "utf8")),
  );
  if (errors.length) {
    errors.forEach((error) => console.error(`AWS governed catalog API check failed: ${error}`));
    process.exitCode = 1;
  } else {
    console.log("AWS governed catalog API check passed: three JWT routes, bounded Data API access, encrypted logs, and PHI refusal are enforced.");
  }
}
