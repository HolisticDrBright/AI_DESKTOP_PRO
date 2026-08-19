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
  assert(errors, JSON.stringify(template.Parameters?.EnvironmentName?.AllowedValues) === JSON.stringify(["production-clinical"]), "environment must be locked to production-clinical");
  assert(errors, JSON.stringify(template.Parameters?.DataClassification?.AllowedValues) === JSON.stringify(["clinical_phi"]), "target data class must be clinical_phi");
  assert(errors, !types.includes("AWS::AppRunner::Service"), "App Runner is forbidden from the PHI target architecture");
  assert(errors, !/(fly\.dev|fly\.io|supabase\.co|supabase_staging)/i.test(serialized), "production foundation must not reference Fly or Supabase SaaS");

  for (const logicalId of ["ClinicalCoreKey", "DatabaseKey", "DocumentsKey", "AuditKey", "BackupKey"]) {
    assert(errors, resources[logicalId]?.Type === "AWS::KMS::Key", `${logicalId} is required`);
    assert(errors, resources[logicalId]?.Properties?.EnableKeyRotation === true, `${logicalId} rotation must be enabled`);
  }
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

  for (const [logicalId, type] of [
    ["GuardDutyDetector", "AWS::GuardDuty::Detector"],
    ["SecurityHub", "AWS::SecurityHub::Hub"],
    ["AccountAccessAnalyzer", "AWS::AccessAnalyzer::Analyzer"],
    ["ConfigurationRecorder", "AWS::Config::ConfigurationRecorder"],
    ["ConfigDeliveryChannel", "AWS::Config::DeliveryChannel"],
    ["ClinicalBackupVault", "AWS::Backup::BackupVault"],
    ["ClinicalBackupPlan", "AWS::Backup::BackupPlan"],
    ["ProductionEcsCluster", "AWS::ECS::Cluster"],
    ["DesktopProductionRepository", "AWS::ECR::Repository"],
    ["PatientApiProductionRepository", "AWS::ECR::Repository"],
  ]) {
    assert(errors, resources[logicalId]?.Type === type, `${logicalId} (${type}) is required`);
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
