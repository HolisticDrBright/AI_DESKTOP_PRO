import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const extensionPath = path.join(root, "infra", "aws-clinical-core", "identity-api-extension.json");
const foundationPath = path.join(root, "infra", "aws-clinical-core", "template.json");

describe("authenticated synthetic API infrastructure", () => {
  test("the structural extension gate passes", () => {
    expect(execFileSync(process.execPath, [path.join(root, "scripts", "check-aws-authenticated-api.mjs")], { encoding: "utf8" }))
      .toContain("synthetic-only Data API access");
  });

  test("Aurora Data API and immutable synthetic Cognito claims are enabled in the foundation", () => {
    const resources = JSON.parse(readFileSync(foundationPath, "utf8")).Resources;
    expect(resources.ClinicalDatabaseCluster.Properties.EnableHttpEndpoint).toBe(true);
    for (const poolName of ["WorkforceUserPool", "ConsumerUserPool"]) {
      expect(resources[poolName].Properties.Schema).toEqual(expect.arrayContaining([
        expect.objectContaining({ Name: "person_id", Mutable: false }),
        expect.objectContaining({ Name: "organization_id", Mutable: false }),
        expect.objectContaining({ Name: "synthetic_attested", Mutable: false }),
      ]));
    }
  });

  test("all clinical routes are JWT-authenticated and the Lambda is tightly bounded", () => {
    const resources = JSON.parse(readFileSync(extensionPath, "utf8")).Resources;
    const routes = Object.values(resources).filter((resource: unknown) => (resource as { Type: string }).Type === "AWS::ApiGatewayV2::Route") as Array<{ Properties: Record<string, unknown> }>;
    expect(routes).toHaveLength(20);
    expect(routes.every((route) => route.Properties.AuthorizationType === "JWT")).toBe(true);
    expect(resources.IdentityApiFunction.Properties).toMatchObject({ Timeout: 15, MemorySize: 256 });
    expect(resources.IdentityApiFunction.Properties.FunctionName)
      .toEqual({ "Fn::Sub": "${ClinicalApiId}-synthetic-identity" });
    expect(resources.IdentityApiFunction.Properties).not.toHaveProperty("ReservedConcurrentExecutions");
    expect(resources.IdentityApiRole.Properties.Policies[2].PolicyDocument.Statement[0].Resource)
      .toEqual({ "Fn::GetAtt": ["IdentityApiLogGroup", "Arn"] });
    expect(resources.IdentityApiLogGroup.Properties.LogGroupName)
      .toBe("/ai-clinical-core/synthetic-staging/identity-api");
    expect(resources.IdentityApiFunction.Properties.LoggingConfig).toMatchObject({
      LogGroup: { Ref: "IdentityApiLogGroup" },
      LogFormat: "JSON",
    });
    expect(resources.IdentityApiFunction.Properties).not.toHaveProperty("VpcConfig");
  });

  test("the Lambda role cannot administer identity, storage, or networking", () => {
    const resources = JSON.parse(readFileSync(extensionPath, "utf8")).Resources;
    const actions = resources.IdentityApiRole.Properties.Policies.flatMap((policy: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } }) =>
      policy.PolicyDocument.Statement.flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]));
    expect(actions.some((action: string) => /^(cognito-idp|s3|ec2):/.test(action))).toBe(false);
    expect(actions.every((action: string) => !action.includes("*"))).toBe(true);
  });

  test("deployment refuses until migration and synthetic foundation posture are explicitly confirmed", () => {
    const source = readFileSync(path.join(root, "scripts", "deploy-aws-authenticated-api.ps1"), "utf8");
    expect(source).toContain("[switch]$ConfirmSyntheticMigrationApplied");
    expect(source.indexOf("if (-not $ConfirmSyntheticMigrationApplied)")).toBeLessThan(source.indexOf("aws s3 cp"));
    expect(source.indexOf("Output 'PhiAllowed'")).toBeLessThan(source.indexOf("aws s3 cp"));
    expect(source).toContain("Output 'DataClassification'");
    expect(source).toContain("Output 'Environment'");
    expect(source).toContain("--sse aws:kms --sse-kms-key-id $kmsKeyArn");
    expect(source).toContain('throw "Authenticated API CloudFormation deployment failed."');
  });

  test("synthetic identity provisioning uses structured requests and Windows-user-protected temporary credentials", () => {
    const source = readFileSync(path.join(root, "scripts", "provision-aws-synthetic-identities.ps1"), "utf8");
    expect(source).toContain("ConvertTo-Json -Depth 5");
    expect(source).toContain("custom:synthetic_attested");
    expect(source).toContain("ConvertFrom-SecureString");
    expect(source).toContain("admin-delete-user");
    expect(source).toContain("ConfirmSyntheticOnly");
    expect(source).not.toMatch(/Write-(Host|Output).*Password/i);
  });

  test("live acceptance uses MFA sessions and destroys the temporary credential envelope", () => {
    const source = readFileSync(path.join(root, "scripts", "run-aws-synthetic-live-acceptance.ps1"), "utf8");
    expect(source).toContain("MFA_SETUP");
    expect(source).toContain("associate-software-token");
    expect(source).toContain("verify-software-token");
    expect(source).toContain("CLINICAL_ISOLATION_WORKFORCE_ID_TOKEN");
    expect(source).toContain("Remove-Item -LiteralPath $credentialPath");
    expect(source).not.toMatch(/Write-Host.*(?:Password|IdToken|SecretCode)/);
  });

  test("request handling has no direct logging path for bodies or claims", () => {
    for (const file of ["aws-identity-api.ts", "rds-data-database.ts", "aws-identity-lambda.ts"]) {
      const source = readFileSync(path.join(root, "src", "server", "clinical-core", file), "utf8");
      expect(source).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\b/);
      expect(source).not.toMatch(/JSON\.stringify\((event|claims|body)\)/);
    }
  });
});
