import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultTemplate = resolve("dist/aws-clinical-core/production-foundation.json");

function assert(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateProductionFoundation(template) {
  const errors = [];
  const resources = template.Resources ?? {};
  const types = Object.values(resources).map((resource) => resource.Type);
  const serialized = JSON.stringify(template);

  assert(errors, template.Metadata?.ClinicalCore?.ContractVersion === "clinical-core/2", "production contract must be clinical-core/2");
  assert(errors, template.Metadata?.ClinicalCore?.ContainsPhi === false, "foundation deployment must not contain PHI");
  assert(errors, template.Metadata?.ClinicalCore?.PhiActivation === "blocked", "PHI activation must be blocked");
  assert(errors, template.Outputs?.PhiAllowed?.Value === "false", "PhiAllowed output must remain false");
  assert(errors, resources.PostureFunction?.Properties?.Environment?.Variables?.CLINICAL_CORE_CONTRACT_VERSION === "clinical-core/2", "posture endpoint must report clinical-core/2");
  assert(errors, resources.PostureFunction?.Properties?.Environment?.Variables?.CLINICAL_CORE_STATUS === "production_foundation_phi_blocked", "posture endpoint must report the PHI-blocked production foundation state");
  assert(errors, JSON.stringify(template.Parameters?.EnvironmentName?.AllowedValues) === JSON.stringify(["production-clinical"]), "environment must be locked to production-clinical");
  assert(errors, JSON.stringify(template.Parameters?.DataClassification?.AllowedValues) === JSON.stringify(["clinical_phi"]), "target data class must be clinical_phi");
  assert(errors, !types.includes("AWS::AppRunner::Service"), "App Runner is forbidden from the PHI target architecture");
  assert(errors, !/(fly\.dev|fly\.io|supabase\.co|supabase_staging)/i.test(serialized), "production foundation must not reference Fly or Supabase SaaS");

  for (const logicalId of ["ClinicalCoreKey", "DatabaseKey", "DocumentsKey", "AuditKey", "BackupKey"]) {
    assert(errors, resources[logicalId]?.Type === "AWS::KMS::Key", `${logicalId} is required`);
    assert(errors, resources[logicalId]?.Properties?.EnableKeyRotation === true, `${logicalId} rotation must be enabled`);
  }
  assert(
    errors,
    resources.ClinicalCoreKey?.Properties?.KeyPolicy?.Statement?.some((statement) => statement.Sid === "CloudWatchLogsEncryption"),
    "ClinicalCoreKey must authorize encrypted CloudWatch Logs",
  );
  assert(
    errors,
    resources.ClinicalApiStage?.DependsOn?.includes("ClinicalApiAccessLogGroup"),
    "ClinicalApiStage must wait for its encrypted access log destination",
  );
  assert(
    errors,
    resources.AuditKey?.Properties?.KeyPolicy?.Statement?.some((statement) => statement.Sid === "AWSConfigEncryption"),
    "AuditKey must authorize AWS Config encryption",
  );
  assert(errors, resources.ClinicalDatabaseCluster?.Properties?.BackupRetentionPeriod === 35, "Aurora must retain 35 days of backups");
  assert(errors, resources.ClinicalDatabaseCluster?.Properties?.DeletionProtection === true, "Aurora deletion protection is required");
  assert(errors, resources.ClinicalDatabaseWriter?.Properties?.PubliclyAccessible === false, "Aurora writer must remain private");
  assert(errors, resources.ClinicalDatabaseWriter?.Properties?.EnablePerformanceInsights === true, "Aurora Performance Insights is required");

  for (const bucketName of ["ClinicalDocumentsBucket", "AuditBucket"]) {
    const bucket = resources[bucketName]?.Properties;
    assert(errors, bucket?.ObjectLockEnabled === true, `${bucketName} must enable Object Lock`);
    assert(errors, bucket?.VersioningConfiguration?.Status === "Enabled", `${bucketName} must enable versioning`);
    assert(errors, Object.values(bucket?.PublicAccessBlockConfiguration ?? {}).every((value) => value === true), `${bucketName} must block public access`);
  }
  const configBucket = resources.ConfigDeliveryBucket?.Properties;
  assert(errors, resources.ConfigDeliveryBucket?.Type === "AWS::S3::Bucket", "ConfigDeliveryBucket is required");
  assert(errors, configBucket?.ObjectLockEnabled !== true, "ConfigDeliveryBucket must not enable Object Lock");
  assert(errors, configBucket?.VersioningConfiguration?.Status === "Enabled", "ConfigDeliveryBucket must enable versioning");
  assert(errors, Object.values(configBucket?.PublicAccessBlockConfiguration ?? {}).every((value) => value === true), "ConfigDeliveryBucket must block public access");
  assert(errors, configBucket?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.KMSMasterKeyID?.["Fn::GetAtt"]?.[0] === "AuditKey", "ConfigDeliveryBucket must use AuditKey encryption");
  assert(errors, resources.ConfigDeliveryBucketPolicy?.Type === "AWS::S3::BucketPolicy", "ConfigDeliveryBucketPolicy is required");
  assert(errors, resources.ConfigDeliveryChannel?.Properties?.S3BucketName?.Ref === "ConfigDeliveryBucket", "AWS Config must use its dedicated delivery bucket");
  assert(errors, resources.ConfigDeliveryChannel?.Properties?.S3KmsKeyArn?.["Fn::GetAtt"]?.[0] === "AuditKey", "AWS Config delivery must use AuditKey encryption");
  assert(errors, resources.ConfigDeliveryChannel?.DependsOn?.includes("ConfigDeliveryBucketPolicy"), "AWS Config delivery must wait for its bucket policy");

  for (const [logicalId, type] of [
    ["GuardDutyDetector", "AWS::GuardDuty::Detector"],
    ["SecurityHub", "AWS::SecurityHub::Hub"],
    ["AccountAccessAnalyzer", "AWS::AccessAnalyzer::Analyzer"],
    ["ConfigurationRecorder", "AWS::Config::ConfigurationRecorder"],
    ["ConfigDeliveryChannel", "AWS::Config::DeliveryChannel"],
    ["ClinicalBackupVault", "AWS::Backup::BackupVault"],
    ["ClinicalBackupPlan", "AWS::Backup::BackupPlan"],
    ["ProductionEcsCluster", "AWS::ECS::Cluster"],
    ["BillingLedger", "AWS::DynamoDB::Table"],
    ["DesktopProductionTaskExecutionRole", "AWS::IAM::Role"],
    ["DesktopProductionTaskRole", "AWS::IAM::Role"],
    ["DesktopProductionRepository", "AWS::ECR::Repository"],
    ["PatientApiProductionRepository", "AWS::ECR::Repository"],
    ["DesktopDomainRegistry", "AWS::SSM::Parameter"],
    ["ClinicalApiDomainRegistry", "AWS::SSM::Parameter"],
    ["WorkforceAuthDomainRegistry", "AWS::SSM::Parameter"],
    ["ConsumerAuthDomainRegistry", "AWS::SSM::Parameter"],
  ]) {
    assert(errors, resources[logicalId]?.Type === type, `${logicalId} (${type}) is required`);
  }

  const billing = resources.BillingLedger?.Properties;
  assert(errors, resources.BillingLedger?.DeletionPolicy === "Retain", "BillingLedger must be retained on stack deletion");
  assert(errors, resources.BillingLedger?.UpdateReplacePolicy === "Retain", "BillingLedger must be retained on replacement");
  assert(errors, billing?.DeletionProtectionEnabled === true, "BillingLedger deletion protection is required");
  assert(errors, billing?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled === true, "BillingLedger point-in-time recovery is required");
  assert(errors, billing?.SSESpecification?.SSEType === "KMS", "BillingLedger must use KMS encryption");
  assert(errors, billing?.SSESpecification?.KMSMasterKeyId?.["Fn::GetAtt"]?.[0] === "ClinicalCoreKey", "BillingLedger must use the application KMS key");
  const billingStatements = resources.DesktopProductionTaskRole?.Properties?.Policies?.flatMap((policy) => policy.PolicyDocument?.Statement ?? []) ?? [];
  assert(errors, billingStatements.length === 1, "Desktop task role must have one minimum-necessary billing statement");
  assert(errors, JSON.stringify(billingStatements[0]?.Action) === JSON.stringify(["dynamodb:PutItem"]), "Desktop task role must only write billing ledger items");
  assert(errors, billingStatements[0]?.Resource?.["Fn::GetAtt"]?.[0] === "BillingLedger", "Desktop task role must be scoped to BillingLedger");

  for (const [parameter, expected] of [
    ["DesktopDomainName", "desktop.ailongevitypro.app"],
    ["ClinicalApiDomainName", "clinical-api.ailongevitypro.app"],
    ["WorkforceAuthDomainName", "staff-auth.ailongevitypro.app"],
    ["ConsumerAuthDomainName", "app-auth.ailongevitypro.app"],
  ]) {
    assert(errors, resources[`${parameter.replace("Name", "Registry")}`]?.Properties?.Value?.Ref === parameter, `${parameter} registry is required`);
    assert(errors, template.Parameters?.[parameter]?.Default === expected, `${parameter} must be locked to ${expected}`);
  }

  for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
    const pool = resources[poolName]?.Properties;
    assert(errors, pool?.DeletionProtection === "ACTIVE", `${poolName} deletion protection is required`);
    assert(errors, pool?.UserPoolAddOns?.AdvancedSecurityMode === "ENFORCED", `${poolName} threat protection must be enforced`);
    assert(errors, !pool?.Schema?.some((attribute) => attribute.Name === "synthetic_attested"), `${poolName} must not contain a synthetic-only claim`);
  }

  return errors;
}

export function readAndValidateProductionFoundation(path = defaultTemplate) {
  return validateProductionFoundation(JSON.parse(readFileSync(path, "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = readAndValidateProductionFoundation(process.argv[2]);
  if (errors.length) {
    for (const error of errors) console.error(`AWS production foundation check failed: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("AWS production foundation check passed: PHI remains blocked; eligible AWS target controls are present.");
  }
}
