import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const foundationPath = fileURLToPath(new URL("../infra/aws-clinical-core/template.json", import.meta.url));
const extensionPath = fileURLToPath(new URL("../infra/aws-clinical-core/identity-api-extension.json", import.meta.url));

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

function actions(statement) {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

export function validateAuthenticatedApi(foundation, extension) {
  const errors = [];
  const base = foundation.Resources ?? {};
  const resources = extension.Resources ?? {};

  assert(errors, extension.Metadata?.ClinicalCore?.ContractVersion === "clinical-core-authenticated-api/1", "extension contract version must be pinned");
  assert(errors, extension.Metadata?.ClinicalCore?.ContainsPhi === false && extension.Metadata?.ClinicalCore?.RealPatientDataAllowed === false, "extension must structurally refuse PHI and real patient data");
  assert(errors, base.ClinicalDatabaseCluster?.Properties?.EnableHttpEndpoint === true, "Aurora Data API must be explicitly enabled");

  for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
    const schema = base[poolName]?.Properties?.Schema ?? [];
    for (const attribute of ["person_id", "organization_id", "synthetic_attested"]) {
      const item = schema.find((entry) => entry.Name === attribute);
      assert(errors, item?.Mutable === false && item?.Required === false, `${poolName}.${attribute} must be immutable and operator-assigned`);
    }
  }

  const routeEntries = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route");
  assert(errors, routeEntries.length === 20, "extension must expose exactly twenty authenticated routes");
  const expectedRoutes = new Set([
    "GET /clinical-core/workforce/posture",
    "GET /clinical-core/consumer/posture",
    "POST /clinical-core/workforce/invitations",
    "POST /clinical-core/consumer/invitations/claim",
    "POST /clinical-core/workforce/consents/grant",
    "POST /clinical-core/consumer/consents/grant",
    "POST /clinical-core/workforce/consents/revoke",
    "POST /clinical-core/consumer/consents/revoke",
    "POST /clinical-core/consumer/labs/import",
    "GET /clinical-core/consumer/connection",
    "GET /clinical-core/consumer/consent-artifact",
    "GET /clinical-core/workforce/lab-imports",
    "POST /clinical-core/workforce/lab-imports/review",
    "GET /clinical-core/workforce/patient-labs",
    "GET /clinical-core/consumer/patient-labs",
    "POST /clinical-core/consumer/records",
    "GET /clinical-core/consumer/records",
    "GET /clinical-core/consumer/privacy/consents",
    "POST /clinical-core/consumer/privacy/requests",
    "GET /clinical-core/consumer/privacy/requests",
  ]);
  for (const [logicalId, route] of routeEntries) {
    assert(errors, expectedRoutes.delete(route.Properties?.RouteKey), `${logicalId} route is unexpected or duplicated`);
    assert(errors, route.Properties?.AuthorizationType === "JWT" && route.Properties?.AuthorizerId, `${logicalId} must use a JWT authorizer`);
  }
  assert(errors, expectedRoutes.size === 0, "one or more required routes are missing");

  for (const name of ["WorkforceJwtAuthorizer", "ConsumerJwtAuthorizer"]) {
    const authorizer = resources[name]?.Properties;
    assert(errors, authorizer?.AuthorizerType === "JWT", `${name} must be JWT`);
    assert(errors, JSON.stringify(authorizer?.IdentitySource) === JSON.stringify(["$request.header.Authorization"]), `${name} must read only the Authorization header`);
    assert(errors, authorizer?.JwtConfiguration?.Issuer && authorizer?.JwtConfiguration?.Audience?.length === 1, `${name} must pin issuer and one audience`);
  }

  const fn = resources.IdentityApiFunction?.Properties;
  assert(errors, fn?.Runtime === "nodejs22.x" && fn?.Architectures?.[0] === "arm64", "Lambda runtime must be bounded and cost-efficient");
  assert(errors, fn?.Timeout === 15 && fn?.MemorySize === 256 && !("ReservedConcurrentExecutions" in fn), "Lambda resource bounds must remain account-compatible");
  assert(errors, !fn?.VpcConfig, "Data API Lambda must not create NAT/VPC networking cost");
  const env = fn?.Environment?.Variables ?? {};
  assert(errors, Object.keys(env).sort().join(",") === [
    "CLINICAL_CONSUMER_AUDIENCE", "CLINICAL_CONSUMER_ISSUER", "CLINICAL_DATABASE_CLUSTER_ARN",
    "CLINICAL_DATABASE_NAME", "CLINICAL_DATABASE_SECRET_ARN", "CLINICAL_WORKFORCE_AUDIENCE",
    "CLINICAL_WORKFORCE_ISSUER",
  ].sort().join(","), "Lambda environment must contain identifiers only");
  assert(errors, Object.values(env).every((value) => value && typeof value === "object"), "Lambda environment must not contain literal credentials");

  const role = resources.IdentityApiRole?.Properties;
  const statements = (role?.Policies ?? []).flatMap((policy) => policy.PolicyDocument?.Statement ?? []);
  const allActions = statements.flatMap(actions);
  for (const required of [
    "rds-data:BeginTransaction", "rds-data:ExecuteStatement", "rds-data:CommitTransaction",
    "rds-data:RollbackTransaction", "secretsmanager:GetSecretValue", "kms:Decrypt",
    "logs:CreateLogStream", "logs:PutLogEvents",
  ]) assert(errors, allActions.includes(required), `IAM action ${required} is required`);
  assert(errors, allActions.every((action) => typeof action === "string" && !action.includes("*")), "IAM actions may not contain wildcards");
  assert(errors, statements.every((statement) => statement.Resource !== "*"), "IAM resources may not be global wildcards");
  assert(errors, !allActions.some((action) => action.startsWith("cognito-idp:") || action.startsWith("s3:")), "request Lambda must not administer Cognito or S3");

  const permission = resources.IdentityApiInvokePermission?.Properties;
  assert(errors, permission?.Principal === "apigateway.amazonaws.com", "only API Gateway may invoke the function");
  assert(errors, JSON.stringify(permission?.SourceArn).includes("/*/clinical-core/*"), "invoke permission must be path bounded");
  assert(errors, resources.IdentityApiLogGroup?.Properties?.RetentionInDays === 30 && resources.IdentityApiLogGroup?.Properties?.KmsKeyId, "logs must be encrypted and expire after 30 days");
  assert(errors, resources.IdentityApiErrorAlarm?.Properties?.Threshold === 1, "first Lambda error must alarm");

  const serialized = JSON.stringify(extension);
  for (const forbidden of ["email", "phone", "birth", "address", "patientName", "service_role", "requestBody", "responseBody"]) {
    assert(errors, !serialized.toLowerCase().includes(forbidden.toLowerCase()), `template contains forbidden PHI/credential/log field ${forbidden}`);
  }
  return errors;
}

export function readAndValidateAuthenticatedApi() {
  return validateAuthenticatedApi(
    JSON.parse(readFileSync(foundationPath, "utf8")),
    JSON.parse(readFileSync(extensionPath, "utf8")),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = readAndValidateAuthenticatedApi();
  if (errors.length) {
    errors.forEach((error) => console.error(`AWS authenticated API check failed: ${error}`));
    process.exitCode = 1;
  } else {
    console.log("AWS authenticated API check passed: Cognito JWTs, least privilege, bounded Lambda, and synthetic-only Data API access.");
  }
}
