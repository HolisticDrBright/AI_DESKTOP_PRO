import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = resolve(root, "infra/aws-clinical-core/template.json");
const defaultOutput = resolve(root, "dist/aws-clinical-core/production-foundation.json");

const clone = (value) => structuredClone(value);

function replaceLogicalId(value, from, to) {
  if (Array.isArray(value)) return value.map((entry) => replaceLogicalId(entry, from, to));
  if (!value || typeof value !== "object") return value === from ? to : value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, replaceLogicalId(entry, from, to)]),
  );
}

function accountKey(baseKey, description, serviceStatements = []) {
  const key = clone(baseKey);
  key.Properties.Description = description;
  key.Properties.KeyPolicy.Statement = [
    clone(baseKey.Properties.KeyPolicy.Statement[0]),
    ...serviceStatements.map(clone),
  ];
  key.Properties.Tags = [
    { Key: "Environment", Value: { Ref: "EnvironmentName" } },
    { Key: "DataClassification", Value: { Ref: "DataClassification" } },
  ];
  return key;
}

function aliasFor(aliasName, target) {
  return {
    Type: "AWS::KMS::Alias",
    Properties: {
      AliasName: { "Fn::Sub": `alias/\${ProjectName}-\${EnvironmentName}-${aliasName}` },
      TargetKeyId: { Ref: target },
    },
  };
}

export function buildProductionFoundation(source) {
  const template = clone(source);
  const resources = template.Resources;
  const baseKey = resources.ClinicalCoreKey;
  const baseStatements = baseKey.Properties.KeyPolicy.Statement;

  template.Description = "Fail-closed AWS production clinical foundation for AI Desktop Pro and AI Longevity Pro V2. Deployment does not authorize PHI.";
  template.Metadata.ClinicalCore = {
    ContractVersion: "clinical-core/2",
    Environment: "production-clinical",
    DataClassification: "clinical_phi_target",
    ContainsPhi: false,
    PhiActivation: "blocked",
  };
  template.Parameters.EnvironmentName = {
    Type: "String",
    Default: "production-clinical",
    AllowedValues: ["production-clinical"],
  };
  template.Parameters.DataClassification = {
    Type: "String",
    Default: "clinical_phi",
    AllowedValues: ["clinical_phi"],
  };
  template.Parameters.MaxAuroraAcu = {
    Type: "Number",
    Default: 4,
    AllowedValues: [2, 4, 8, 16],
  };
  for (const [name, domain] of [
    ["DesktopDomainName", "desktop.ailongevitypro.app"],
    ["ClinicalApiDomainName", "clinical-api.ailongevitypro.app"],
    ["WorkforceAuthDomainName", "staff-auth.ailongevitypro.app"],
    ["ConsumerAuthDomainName", "app-auth.ailongevitypro.app"],
  ]) {
    template.Parameters[name] = {
      Type: "String",
      Default: domain,
      AllowedValues: [domain],
    };
  }

  resources.ClinicalCoreKey.Properties.Description = { "Fn::Sub": "${ProjectName}-${EnvironmentName} application-service encryption" };
  resources.ClinicalCoreKey.Properties.KeyPolicy.Statement = [
    clone(baseStatements[0]),
    clone(baseStatements.find((statement) => statement.Sid === "CloudWatchLogsEncryption")),
  ];
  resources.ClinicalCoreKeyAlias.Properties.AliasName = { "Fn::Sub": "alias/${ProjectName}-${EnvironmentName}-application" };

  resources.DatabaseKey = accountKey(baseKey, { "Fn::Sub": "${ProjectName}-${EnvironmentName} Aurora encryption" });
  resources.DatabaseKeyAlias = aliasFor("database", "DatabaseKey");
  resources.DocumentsKey = accountKey(baseKey, { "Fn::Sub": "${ProjectName}-${EnvironmentName} clinical document encryption" });
  resources.DocumentsKeyAlias = aliasFor("documents", "DocumentsKey");
  resources.AuditKey = accountKey(baseKey, { "Fn::Sub": "${ProjectName}-${EnvironmentName} audit encryption" }, baseStatements.slice(1));
  resources.AuditKey.Properties.KeyPolicy.Statement.push({
    Sid: "AWSConfigEncryption",
    Effect: "Allow",
    Principal: { Service: "config.amazonaws.com" },
    Action: ["kms:Decrypt", "kms:GenerateDataKey"],
    Resource: "*",
    Condition: {
      StringEquals: { "AWS:SourceAccount": { Ref: "AWS::AccountId" } },
      ArnLike: { "AWS:SourceArn": { "Fn::Sub": "arn:${AWS::Partition}:config:${AWS::Region}:${AWS::AccountId}:*" } },
    },
  });
  resources.AuditKeyAlias = aliasFor("audit", "AuditKey");
  resources.BackupKey = accountKey(baseKey, { "Fn::Sub": "${ProjectName}-${EnvironmentName} backup encryption" });
  resources.BackupKeyAlias = aliasFor("backup", "BackupKey");

  for (const name of ["ClinicalDocumentsBucket", "ClinicalDocumentsBucketPolicy"]) {
    resources[name] = replaceLogicalId(resources[name], "ClinicalCoreKey", "DocumentsKey");
  }
  for (const name of ["AuditBucket", "AuditBucketPolicy", "AuditLogGroup", "AuditTrail"]) {
    resources[name] = replaceLogicalId(resources[name], "ClinicalCoreKey", "AuditKey");
  }
  resources.ClinicalDatabaseCluster = replaceLogicalId(resources.ClinicalDatabaseCluster, "ClinicalCoreKey", "DatabaseKey");

  resources.ClinicalDocumentsBucket.Properties.ObjectLockEnabled = true;
  resources.ClinicalDocumentsBucket.Properties.ObjectLockConfiguration = {
    ObjectLockEnabled: "Enabled",
    Rule: { DefaultRetention: { Mode: "GOVERNANCE", Years: 7 } },
  };
  resources.ClinicalDocumentsBucket.Properties.LifecycleConfiguration.Rules = [{
    Id: "RetainClinicalHistory",
    Status: "Enabled",
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  }];

  resources.AuditBucket.Properties.ObjectLockEnabled = true;
  resources.AuditBucket.Properties.ObjectLockConfiguration = {
    ObjectLockEnabled: "Enabled",
    Rule: { DefaultRetention: { Mode: "COMPLIANCE", Years: 7 } },
  };
  resources.AuditBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 2557;
  resources.AuditLogGroup.Properties.RetentionInDays = 365;

  const database = resources.ClinicalDatabaseCluster.Properties;
  database.BackupRetentionPeriod = 35;
  database.DeleteAutomatedBackups = false;
  database.ServerlessV2ScalingConfiguration.MinCapacity = 0.5;
  delete database.ServerlessV2ScalingConfiguration.SecondsUntilAutoPause;
  const writer = resources.ClinicalDatabaseWriter.Properties;
  writer.EnablePerformanceInsights = true;
  writer.PerformanceInsightsKMSKeyId = { "Fn::GetAtt": ["DatabaseKey", "Arn"] };
  writer.PerformanceInsightsRetentionPeriod = 7;

  for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
    const pool = resources[poolName].Properties;
    pool.Schema = pool.Schema.filter((attribute) => attribute.Name !== "synthetic_attested");
    pool.UserPoolAddOns = { AdvancedSecurityMode: "ENFORCED" };
  }

  resources.GuardDutyDetector = {
    Type: "AWS::GuardDuty::Detector",
    Properties: {
      Enable: true,
      FindingPublishingFrequency: "FIFTEEN_MINUTES",
      Features: [
        { Name: "S3_DATA_EVENTS", Status: "ENABLED" },
        { Name: "RUNTIME_MONITORING", Status: "ENABLED" },
      ],
      Tags: [{ Key: "Environment", Value: { Ref: "EnvironmentName" } }],
    },
  };
  resources.SecurityHub = {
    Type: "AWS::SecurityHub::Hub",
    Properties: {
      AutoEnableControls: true,
      EnableDefaultStandards: true,
      Tags: { Environment: { Ref: "EnvironmentName" } },
    },
  };
  resources.AccountAccessAnalyzer = {
    Type: "AWS::AccessAnalyzer::Analyzer",
    Properties: {
      AnalyzerName: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
      Type: "ACCOUNT",
      Tags: [{ Key: "Environment", Value: { Ref: "EnvironmentName" } }],
    },
  };

  resources.ConfigRecorderRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "config.amazonaws.com" }, Action: "sts:AssumeRole" }],
      },
      ManagedPolicyArns: [{ "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/service-role/AWS_ConfigRole" }],
    },
  };
  resources.ConfigurationRecorder = {
    Type: "AWS::Config::ConfigurationRecorder",
    Properties: {
      Name: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
      RoleARN: { "Fn::GetAtt": ["ConfigRecorderRole", "Arn"] },
      RecordingGroup: { AllSupported: true, IncludeGlobalResourceTypes: true },
    },
  };
  resources.ConfigDeliveryBucket = {
    Type: "AWS::S3::Bucket",
    Properties: {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: {
            KMSMasterKeyID: { "Fn::GetAtt": ["AuditKey", "Arn"] },
            SSEAlgorithm: "aws:kms",
          },
        }],
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerPreferred" }] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: [{ Id: "RetainConfigHistory", Status: "Enabled", ExpirationInDays: 2557 }],
      },
      Tags: [
        { Key: "Environment", Value: { Ref: "EnvironmentName" } },
        { Key: "DataClassification", Value: { Ref: "DataClassification" } },
      ],
    },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  resources.ConfigDeliveryBucketPolicy = {
    Type: "AWS::S3::BucketPolicy",
    Properties: {
      Bucket: { Ref: "ConfigDeliveryBucket" },
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ConfigBucketPermissionsCheck",
            Effect: "Allow",
            Principal: { Service: "config.amazonaws.com" },
            Action: ["s3:GetBucketAcl", "s3:ListBucket"],
            Resource: { "Fn::GetAtt": ["ConfigDeliveryBucket", "Arn"] },
            Condition: {
              StringEquals: { "AWS:SourceAccount": { Ref: "AWS::AccountId" } },
              ArnLike: { "AWS:SourceArn": { "Fn::Sub": "arn:${AWS::Partition}:config:${AWS::Region}:${AWS::AccountId}:*" } },
            },
          },
          {
            Sid: "ConfigBucketDelivery",
            Effect: "Allow",
            Principal: { Service: "config.amazonaws.com" },
            Action: ["s3:PutObject", "s3:PutObjectAcl"],
            Resource: { "Fn::Sub": "${ConfigDeliveryBucket.Arn}/config/AWSLogs/${AWS::AccountId}/Config/*" },
            Condition: {
              StringEquals: {
                "s3:x-amz-acl": "bucket-owner-full-control",
                "AWS:SourceAccount": { Ref: "AWS::AccountId" },
              },
              ArnLike: { "AWS:SourceArn": { "Fn::Sub": "arn:${AWS::Partition}:config:${AWS::Region}:${AWS::AccountId}:*" } },
            },
          },
          {
            Sid: "DenyInsecureTransport",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [
              { "Fn::GetAtt": ["ConfigDeliveryBucket", "Arn"] },
              { "Fn::Sub": "${ConfigDeliveryBucket.Arn}/*" },
            ],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      },
    },
  };
  resources.ConfigDeliveryChannel = {
    Type: "AWS::Config::DeliveryChannel",
    DependsOn: ["ConfigDeliveryBucketPolicy"],
    Properties: {
      Name: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
      S3BucketName: { Ref: "ConfigDeliveryBucket" },
      S3KeyPrefix: "config",
      S3KmsKeyArn: { "Fn::GetAtt": ["AuditKey", "Arn"] },
      ConfigSnapshotDeliveryProperties: { DeliveryFrequency: "Six_Hours" },
    },
  };

  resources.ClinicalBackupVault = {
    Type: "AWS::Backup::BackupVault",
    Properties: {
      BackupVaultName: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
      EncryptionKeyArn: { "Fn::GetAtt": ["BackupKey", "Arn"] },
      LockConfiguration: { ChangeableForDays: 3, MinRetentionDays: 35, MaxRetentionDays: 3653 },
      BackupVaultTags: { Environment: { Ref: "EnvironmentName" }, DataClassification: { Ref: "DataClassification" } },
    },
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  };
  resources.BackupServiceRole = {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "backup.amazonaws.com" }, Action: "sts:AssumeRole" }],
      },
      ManagedPolicyArns: [
        { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup" },
        { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores" },
        { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup" },
        { "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore" },
      ],
    },
  };
  resources.ClinicalBackupPlan = {
    Type: "AWS::Backup::BackupPlan",
    Properties: {
      BackupPlan: {
        BackupPlanName: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
        BackupPlanRule: [{
          RuleName: "daily-clinical-backup",
          TargetBackupVault: { Ref: "ClinicalBackupVault" },
          ScheduleExpression: "cron(0 7 ? * * *)",
          StartWindowMinutes: 60,
          CompletionWindowMinutes: 240,
          Lifecycle: { MoveToColdStorageAfterDays: 30, DeleteAfterDays: 2557 },
          RecoveryPointTags: { Environment: { Ref: "EnvironmentName" }, DataClassification: { Ref: "DataClassification" } },
        }],
      },
      BackupPlanTags: { Environment: { Ref: "EnvironmentName" } },
    },
  };
  resources.ClinicalBackupSelection = {
    Type: "AWS::Backup::BackupSelection",
    Properties: {
      BackupPlanId: { Ref: "ClinicalBackupPlan" },
      BackupSelection: {
        SelectionName: "aurora-and-clinical-documents",
        IamRoleArn: { "Fn::GetAtt": ["BackupServiceRole", "Arn"] },
        Resources: [
          { "Fn::GetAtt": ["ClinicalDatabaseCluster", "DBClusterArn"] },
          { "Fn::GetAtt": ["ClinicalDocumentsBucket", "Arn"] },
        ],
      },
    },
  };

  resources.ProductionEcsCluster = {
    Type: "AWS::ECS::Cluster",
    Properties: {
      ClusterName: { "Fn::Sub": "${ProjectName}-${EnvironmentName}" },
      ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
      Tags: [{ Key: "Environment", Value: { Ref: "EnvironmentName" } }],
    },
  };
  for (const [logicalId, repositoryName] of [
    ["DesktopProductionRepository", "ai-desktop-pro-production"],
    ["PatientApiProductionRepository", "ai-longevity-pro-v2-production"],
  ]) {
    resources[logicalId] = {
      Type: "AWS::ECR::Repository",
      Properties: {
        RepositoryName: repositoryName,
        ImageTagMutability: "IMMUTABLE",
        ImageScanningConfiguration: { ScanOnPush: true },
        EncryptionConfiguration: { EncryptionType: "KMS", KmsKey: { "Fn::GetAtt": ["ClinicalCoreKey", "Arn"] } },
        Tags: [
          { Key: "Environment", Value: { Ref: "EnvironmentName" } },
          { Key: "DataClassification", Value: { Ref: "DataClassification" } },
        ],
      },
    };
  }

  for (const [logicalId, path, parameter] of [
    ["DesktopDomainRegistry", "desktop-domain", "DesktopDomainName"],
    ["ClinicalApiDomainRegistry", "clinical-api-domain", "ClinicalApiDomainName"],
    ["WorkforceAuthDomainRegistry", "workforce-auth-domain", "WorkforceAuthDomainName"],
    ["ConsumerAuthDomainRegistry", "consumer-auth-domain", "ConsumerAuthDomainName"],
  ]) {
    resources[logicalId] = {
      Type: "AWS::SSM::Parameter",
      Properties: {
        Name: { "Fn::Sub": `/\${ProjectName}/\${EnvironmentName}/endpoints/${path}` },
        Type: "String",
        Value: { Ref: parameter },
        Description: "Reserved production endpoint name; DNS activation is a separate reviewed change.",
        Tags: { Environment: { Ref: "EnvironmentName" }, PhiAllowed: "false" },
      },
    };
  }

  resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_PHI_ALLOWED = "false";
  resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_CONTRACT_VERSION = "clinical-core/2";
  resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_ENVIRONMENT = "production-clinical";
  resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_DATA_CLASSIFICATION = "clinical_phi_target";
  resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_STATUS = "production_foundation_phi_blocked";
  resources.ClinicalApiStage.DependsOn = ["ClinicalApiAccessLogGroup"];

  template.Outputs.ContractVersion.Value = "clinical-core/2";
  template.Outputs.Environment.Value = "production-clinical";
  template.Outputs.DataClassification.Value = "clinical_phi_target";
  template.Outputs.PhiAllowed.Value = "false";
  template.Outputs.ProductionEcsClusterArn = { Value: { "Fn::GetAtt": ["ProductionEcsCluster", "Arn"] } };
  template.Outputs.DesktopProductionRepositoryUri = { Value: { "Fn::GetAtt": ["DesktopProductionRepository", "RepositoryUri"] } };
  template.Outputs.PatientApiProductionRepositoryUri = { Value: { "Fn::GetAtt": ["PatientApiProductionRepository", "RepositoryUri"] } };
  template.Outputs.GuardDutyDetectorId = { Value: { Ref: "GuardDutyDetector" } };
  template.Outputs.SecurityHubArn = { Value: { Ref: "SecurityHub" } };
  template.Outputs.AccessAnalyzerArn = { Value: { "Fn::GetAtt": ["AccountAccessAnalyzer", "Arn"] } };
  template.Outputs.BackupVaultName = { Value: { Ref: "ClinicalBackupVault" } };
  template.Outputs.DesktopDomainName = { Value: { Ref: "DesktopDomainName" } };
  template.Outputs.ClinicalApiDomainName = { Value: { Ref: "ClinicalApiDomainName" } };
  template.Outputs.WorkforceAuthDomainName = { Value: { Ref: "WorkforceAuthDomainName" } };
  template.Outputs.ConsumerAuthDomainName = { Value: { Ref: "ConsumerAuthDomainName" } };

  return template;
}

export function buildFromDisk(sourcePath = defaultSource, outputPath = defaultOutput) {
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const production = buildProductionFoundation(source);
  mkdirSync(dirname(outputPath), { recursive: true });
  // Keep the generated artifact below CloudFormation's direct template-body
  // limit. The reviewed source remains the generator plus the readable base.
  writeFileSync(outputPath, `${JSON.stringify(production)}\n`);
  return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = buildFromDisk(
    resolve(process.argv[2] ?? defaultSource),
    resolve(process.argv[3] ?? defaultOutput),
  );
  console.log(output);
}
