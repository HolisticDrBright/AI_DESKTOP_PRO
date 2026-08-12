import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const templatePath = path.join(repoRoot, "infra", "aws-clinical-core", "template.json");
const checkPath = path.join(repoRoot, "scripts", "check-aws-clinical-core.mjs");
const preflightPath = path.join(repoRoot, "scripts", "preflight-aws-synthetic.mjs");
const deployScriptPath = path.join(repoRoot, "scripts", "deploy-aws-synthetic.ps1");
const temporaryDirectories: string[] = [];

type CloudFormationResource = {
  Type: string;
  Properties?: Record<string, unknown>;
};

function readTemplate() {
  return JSON.parse(readFileSync(templatePath, "utf8"));
}

function writeManifest(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "clinical-core-preflight-"));
  temporaryDirectories.push(directory);
  const manifestPath = path.join(directory, "deployment-manifest.json");
  const manifest = {
    schema_version: "aws-clinical-core-deployment/1",
    environment: "synthetic-staging",
    data_classification: "synthetic_only",
    contains_phi: false,
    real_patient_data_allowed: false,
    vendor_phi_enabled: false,
    aws_baa_status: "pending-organization-acceptance",
    aws_account_id: "123456789012",
    aws_region: "us-east-2",
    budget_alert_email: "security@example.test",
    allowed_client_origins: ["http://127.0.0.1:3000"],
    approvals: {
      infrastructure_owner: "Synthetic Staging Owner",
      security_reviewer: "Synthetic Security Reviewer",
      reviewed_at: "2026-08-11T12:00:00.000Z",
    },
    ...overrides,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AWS synthetic clinical-core infrastructure", () => {
  test("the structural safety gate passes the committed template", () => {
    expect(execFileSync(process.execPath, [checkPath], { cwd: repoRoot, encoding: "utf8" }))
      .toContain("synthetic-only, encrypted, private, audited, and budget-bounded");
  });

  test("the Windows deployment script passes a valid AWS CLI file URI", () => {
    const script = readFileSync(deployScriptPath, "utf8");
    expect(script).toContain('$templateUri = "file://" + ($templatePath -replace "\\\\", "/")');
    expect(script).not.toContain('$templateUri = "file:///"');
  });

  test("production and PHI are not parameter choices", () => {
    const template = readTemplate();
    expect(template.Metadata.ClinicalCore.ContainsPhi).toBe(false);
    expect(template.Parameters.EnvironmentName.AllowedValues).toEqual(["synthetic-staging"]);
    expect(template.Parameters.DataClassification.AllowedValues).toEqual(["synthetic_only"]);
    expect(template.Outputs.PhiAllowed.Value).toBe("false");
  });

  test("the budget baseline contains no fixed-price network or compute layer", () => {
    const template = readTemplate();
    const types = (Object.values(template.Resources) as CloudFormationResource[])
      .map((resource) => resource.Type);
    expect(types).not.toContain("AWS::EC2::NatGateway");
    expect(types).not.toContain("AWS::EC2::EIP");
    expect(types).not.toContain("AWS::ElasticLoadBalancingV2::LoadBalancer");
    expect(types).not.toContain("AWS::ECS::Service");
    expect(template.Resources.ClinicalDatabaseCluster.Properties.ServerlessV2ScalingConfiguration)
      .toMatchObject({ MinCapacity: 0, SecondsUntilAutoPause: 900 });
    expect(template.Resources.MonthlyBudget.Properties.Budget.BudgetLimit)
      .toEqual({ Amount: 100, Unit: "USD" });
  });

  test("identity, storage, database, and audit boundaries are fail closed", () => {
    const resources = readTemplate().Resources;
    expect(resources.WorkforceUserPool.Properties.MfaConfiguration).toBe("ON");
    expect(resources.ConsumerUserPool.Properties.MfaConfiguration).toBe("OPTIONAL");
    expect(resources.ClinicalDatabaseWriter.Properties.PubliclyAccessible).toBe(false);
    expect(resources.DatabaseSecurityGroup.Properties.SecurityGroupEgress).toEqual([{
      Description: "Private VPC only; the VPC has no internet route",
      IpProtocol: "-1",
      CidrIp: "10.40.0.0/24",
    }]);
    expect(resources.DatabaseSecurityGroup.Properties).not.toHaveProperty("SecurityGroupIngress");
    expect(resources.ClinicalDocumentsBucket.Properties.PublicAccessBlockConfiguration)
      .toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(resources.ClinicalQueuePolicy.Properties.PolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Sid: "DenyInsecureTransportEvents",
        Resource: { "Fn::GetAtt": ["ClinicalEventsQueue", "Arn"] },
      }),
      expect.objectContaining({
        Sid: "DenyInsecureTransportDeadLetter",
        Resource: { "Fn::GetAtt": ["ClinicalDeadLetterQueue", "Arn"] },
      }),
    ]);
    expect(resources.AuditTrail.Properties).toMatchObject({
      EnableLogFileValidation: true,
      IsLogging: true,
      IsMultiRegionTrail: true,
      CloudWatchLogsLogGroupArn: { "Fn::GetAtt": ["AuditLogGroup", "Arn"] },
    });
    expect(resources.AuditLogGroup.Properties.LogGroupName)
      .toEqual({ "Fn::Sub": "/${ProjectName}/${EnvironmentName}/cloudtrail-v2" });
    expect(resources.CloudTrailLogsRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource)
      .toEqual({ "Fn::GetAtt": ["AuditLogGroup", "Arn"] });
  });

  test("the only deployed handler is a non-clinical posture endpoint", () => {
    const resources = readTemplate().Resources;
    const functions = (Object.values(resources) as CloudFormationResource[])
      .filter((resource) => resource.Type === "AWS::Lambda::Function");
    expect(functions).toHaveLength(1);
    expect(resources.PostureRoute.Properties.RouteKey).toBe("GET /posture");
    expect(resources.PostureFunction.Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    expect(resources.ClinicalApiStage.Properties.DefaultRouteSettings).toMatchObject({
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    });
    expect(resources.ClinicalApiStage.Properties.AccessLogSettings.DestinationArn).toEqual({
      "Fn::Sub": "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/${ProjectName}/${EnvironmentName}/api-access",
    });
    expect(resources.PostureFunction.Properties.Environment.Variables.CLINICAL_CORE_PHI_ALLOWED).toBe("false");
    expect(resources.PostureFunction.Properties.Code.ZipFile).toContain("synthetic_staging_not_configured");
  });

  test("a fully reviewed synthetic manifest passes preflight", () => {
    const result = execFileSync(process.execPath, [preflightPath, writeManifest()], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(JSON.parse(result)).toEqual({
      ok: true,
      environment: "synthetic-staging",
      data_classification: "synthetic_only",
      contains_phi: false,
      aws_baa_status: "pending-organization-acceptance",
      baa_activation_pending: true,
      phi_activation_blocked: true,
      aws_account_id: "123456789012",
      aws_region: "us-east-2",
    });
  });

  test.each([
    ["PHI declaration", { contains_phi: true }, "contains_phi must be false"],
    ["production environment", { environment: "production" }, "environment must be synthetic-staging"],
    ["real-patient enablement", { real_patient_data_allowed: true }, "real_patient_data_allowed must be false"],
    ["connector PHI", { vendor_phi_enabled: true }, "vendor_phi_enabled must be false"],
    ["unknown BAA state", { aws_baa_status: "unknown" }, "aws_baa_status must be pending-organization-acceptance or accepted"],
    ["wrong account", { aws_account_id: "000000000000" }, "aws_account_id must be the intended"],
    ["wrong region", { aws_region: "us-west-1" }, "aws_region must be the reviewed us-east-2"],
    ["unapproved origin", { allowed_client_origins: ["http://clinical.example"] }, "unapproved client origin"],
  ])("refuses %s", (_name, overrides, expectedError) => {
    const result = spawnSync(process.execPath, [preflightPath, writeManifest(overrides)], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedError);
  });

  test("records an accepted BAA without weakening the synthetic-only boundary", () => {
    const result = execFileSync(process.execPath, [preflightPath, writeManifest({ aws_baa_status: "accepted" })], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(JSON.parse(result)).toMatchObject({
      contains_phi: false,
      aws_baa_status: "accepted",
      baa_activation_pending: false,
      phi_activation_blocked: true,
    });
  });
});
