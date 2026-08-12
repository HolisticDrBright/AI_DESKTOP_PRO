import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultTemplateUrl = new URL("../infra/aws-clinical-core/template.json", import.meta.url);

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateClinicalCoreTemplate(template) {
  const errors = [];
  const resources = template.Resources ?? {};
  const parameters = template.Parameters ?? {};

  assert(errors, template.Metadata?.ClinicalCore?.ContractVersion === "clinical-core/1", "contract version must be clinical-core/1");
  assert(errors, template.Metadata?.ClinicalCore?.ContainsPhi === false, "template metadata must refuse PHI");
  assert(errors, valuesEqual(parameters.EnvironmentName?.AllowedValues, ["synthetic-staging"]), "environment must be locked to synthetic-staging");
  assert(errors, valuesEqual(parameters.DataClassification?.AllowedValues, ["synthetic_only"]), "data classification must be locked to synthetic_only");

  const resourceTypes = Object.values(resources).map((resource) => resource.Type);
  for (const forbiddenType of [
    "AWS::EC2::NatGateway",
    "AWS::EC2::EIP",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::ECS::Service",
  ]) {
    assert(errors, !resourceTypes.includes(forbiddenType), `${forbiddenType} is forbidden in the budget baseline`);
  }

  const kmsKey = resources.ClinicalCoreKey?.Properties;
  assert(errors, kmsKey?.EnableKeyRotation === true, "KMS key rotation must be enabled");

  for (const bucketName of ["ClinicalDocumentsBucket", "AuditBucket"]) {
    const bucket = resources[bucketName]?.Properties;
    assert(errors, bucket?.VersioningConfiguration?.Status === "Enabled", `${bucketName} must enable versioning`);
    const publicBlock = bucket?.PublicAccessBlockConfiguration;
    assert(errors, publicBlock && Object.values(publicBlock).every((value) => value === true), `${bucketName} must block all public access`);
    const encryption = bucket?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault;
    assert(errors, encryption?.SSEAlgorithm === "aws:kms" && encryption?.KMSMasterKeyID, `${bucketName} must use the clinical KMS key`);
  }

  const workforce = resources.WorkforceUserPool?.Properties;
  const consumer = resources.ConsumerUserPool?.Properties;
  assert(errors, workforce?.MfaConfiguration === "ON", "workforce MFA must be required");
  assert(errors, consumer?.MfaConfiguration === "OPTIONAL", "consumer MFA must be available");
  assert(errors, workforce?.DeletionProtection === "ACTIVE" && consumer?.DeletionProtection === "ACTIVE", "both user pools must enable deletion protection");
  assert(errors, resources.WorkforceUserPoolClient?.Properties?.GenerateSecret === false, "workforce public client must not carry a client secret");
  assert(errors, resources.ConsumerUserPoolClient?.Properties?.GenerateSecret === false, "consumer public client must not carry a client secret");
  for (const [name, pool] of [["workforce", workforce], ["consumer", consumer]]) {
    for (const attribute of ["person_id", "organization_id", "synthetic_attested"]) {
      const schema = pool?.Schema?.find((entry) => entry.Name === attribute);
      assert(errors, schema?.Mutable === false && schema?.Required === false, `${name} ${attribute} must be immutable and operator-assigned`);
    }
  }

  const database = resources.ClinicalDatabaseCluster?.Properties;
  const databaseWriter = resources.ClinicalDatabaseWriter?.Properties;
  assert(errors, database?.StorageEncrypted === true, "Aurora storage encryption must be enabled");
  assert(errors, database?.ManageMasterUserPassword === true, "Aurora credentials must be managed by Secrets Manager");
  assert(errors, database?.DeletionProtection === true, "Aurora deletion protection must be enabled");
  assert(errors, database?.EnableIAMDatabaseAuthentication === true, "Aurora IAM authentication must be enabled");
  assert(errors, database?.EnableHttpEndpoint === true, "Aurora Data API must be enabled for the no-NAT authenticated API");
  assert(errors, database?.ServerlessV2ScalingConfiguration?.MinCapacity === 0, "Aurora must be able to auto-pause at zero ACUs");
  assert(errors, database?.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause >= 300, "Aurora auto-pause must be configured");
  assert(errors, databaseWriter?.PubliclyAccessible === false, "Aurora must not be public");
  const databaseEgress = resources.DatabaseSecurityGroup?.Properties?.SecurityGroupEgress;
  assert(errors, valuesEqual(databaseEgress, [{
    Description: "Private VPC only; the VPC has no internet route",
    IpProtocol: "-1",
    CidrIp: "10.40.0.0/24",
  }]), "database security group egress must stay inside the unrouted private VPC");
  assert(errors, !("SecurityGroupIngress" in (resources.DatabaseSecurityGroup?.Properties ?? {})), "database security group must have no ingress in this slice");

  const trail = resources.AuditTrail?.Properties;
  assert(errors, trail?.IsLogging === true, "CloudTrail must start logging with the stack");
  assert(errors, trail?.EnableLogFileValidation === true, "CloudTrail log validation must be enabled");
  assert(errors, trail?.IsMultiRegionTrail === true, "CloudTrail must cover every region");

  const apiFormat = resources.ClinicalApiStage?.Properties?.AccessLogSettings?.Format ?? "";
  assert(errors, apiFormat.includes("$context.requestId") && apiFormat.includes("$context.status"), "API logs must preserve request and status identifiers");
  assert(errors, !/(authorization|cookie|sourceIp|requestBody|responseBody)/i.test(apiFormat), "API logs must not include credentials, bodies, or source IPs");
  assert(errors, valuesEqual(resources.PostureRoute?.Properties?.RouteKey, "GET /posture"), "synthetic baseline may expose only the posture route");
  assert(errors, resourceTypes.filter((type) => type === "AWS::Lambda::Function").length === 1, "synthetic baseline must ship exactly one non-clinical Lambda");

  const functionVariables = resources.PostureFunction?.Properties?.Environment?.Variables ?? {};
  assert(errors, functionVariables.CLINICAL_CORE_PHI_ALLOWED === "false", "posture function must report PHI unavailable");
  assert(errors, !Object.keys(functionVariables).some((key) => /(secret|password|token|api.?key)/i.test(key)), "Lambda environment must not carry secret-shaped fields");

  const budget = resources.MonthlyBudget?.Properties;
  assert(errors, budget?.Budget?.BudgetLimit?.Amount === 100 && budget?.Budget?.BudgetLimit?.Unit === "USD", "monthly budget must be $100");
  const thresholds = (budget?.NotificationsWithSubscribers ?? []).map((entry) => entry.Notification?.Threshold).sort((a, b) => a - b);
  assert(errors, valuesEqual(thresholds, [80, 100]), "budget alerts must fire at 80% and 100%");

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Role") continue;
    for (const policy of resource.Properties?.Policies ?? []) {
      for (const statement of policy.PolicyDocument?.Statement ?? []) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        assert(errors, !actions.includes("*"), `${logicalId} contains a wildcard IAM action`);
      }
    }
  }

  return errors;
}

export function readAndValidateTemplate(path = fileURLToPath(defaultTemplateUrl)) {
  const template = JSON.parse(readFileSync(path, "utf8"));
  return validateClinicalCoreTemplate(template);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = readAndValidateTemplate(process.argv[2]);
  if (errors.length) {
    for (const error of errors) console.error(`AWS clinical-core check failed: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("AWS clinical-core check passed: synthetic-only, encrypted, private, audited, and budget-bounded.");
  }
}
