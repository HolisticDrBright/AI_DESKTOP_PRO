import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
let template: { Parameters: Record<string, { Default?: string }>; Conditions: Record<string, Json>;
  Resources: Record<string, { Type: string; Properties: Record<string, Json>; DeletionPolicy?: string }> };
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/build-aws-recording-authority.mjs"], { stdio: "pipe" });
  template = JSON.parse(readFileSync("dist/aws-clinical-core/recording-authority/template.json", "utf8"));
}, 20000);
function evaluate(value: Json, parameters: Record<string, string>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => evaluate(v, parameters));
  if (typeof value.Ref === "string") return parameters[value.Ref] ?? "";
  if (value["Fn::Equals"]) { const args = evaluate(value["Fn::Equals"], parameters) as unknown[]; return args[0] === args[1]; }
  if (value["Fn::Not"]) return !(evaluate(value["Fn::Not"], parameters) as unknown[])[0];
  if (value["Fn::And"]) return (evaluate(value["Fn::And"], parameters) as unknown[]).every(Boolean);
  throw new Error("unsupported_condition");
}
describe("recording authority deployable candidate", () => {
  it("grants only logs until all database, workforce and activation prerequisites are supplied", () => {
    const defaults = Object.fromEntries(Object.entries(template.Parameters).map(([k, v]) => [k, v.Default ?? ""]));
    const approved = { ...defaults, PhiAllowed: "true", Activation: "approved", ActivationEvidenceSha256: "a".repeat(64),
      DatabaseReviewSha256: "b".repeat(64), WorkforceMfaReviewSha256: "c".repeat(64), AlarmTopicArn: "arn:aws:sns:us-east-2:123456789012:fictional" };
    expect(evaluate(template.Conditions.Active, defaults)).toBe(false);
    expect(evaluate(template.Conditions.Active, approved)).toBe(true);
    for (const key of ["PhiAllowed", "Activation", "ActivationEvidenceSha256", "DatabaseReviewSha256", "WorkforceMfaReviewSha256", "AlarmTopicArn"])
      expect(evaluate(template.Conditions.Active, { ...approved, [key]: defaults[key] })).toBe(false);
    const policies = template.Resources.Role.Properties.Policies as Json[];
    expect(JSON.stringify(policies[0])).not.toMatch(/rds-data:|secretsmanager:|kms:/);
    expect((policies[1] as Record<string, Json>)["Fn::If"]).toEqual(["Active", expect.any(Object), { Ref: "AWS::NoValue" }]);
    expect(JSON.stringify(policies)).not.toMatch(/s3:|transcribe:|bedrock:|"Resource":"\*"/);
    expect(JSON.stringify(policies)).toContain("kms:EncryptionContext:SecretARN");
  });
  it("provides only the workforce authority route with pinned code and encrypted retained logs", () => {
    const resources = template.Resources;
    expect(Object.values(resources).filter(r => r.Type === "AWS::ApiGatewayV2::Route")).toHaveLength(1);
    expect(resources.Route.Properties).toMatchObject({ RouteKey: "POST /clinical-core/workforce/encounter-recording/authority", AuthorizationType: "JWT", AuthorizerId: { Ref: "Authorizer" } });
    expect(resources.Authorizer.Properties.JwtConfiguration).toEqual({ Issuer: { Ref: "WorkforceIssuer" }, Audience: [{ Ref: "WorkforceAudience" }] });
    expect(resources.Function.Properties.Code).toMatchObject({ S3ObjectVersion: { Ref: "CodeVersion" } });
    expect(resources.Function.Properties.ReservedConcurrentExecutions).toBe(2);
    expect(resources.Logs.Properties.KmsKeyId).toEqual({ Ref: "LogsKmsKeyArn" });
    expect(resources.Logs.DeletionPolicy).toBe("Retain");
    expect(resources.ApiFailureAlarm.Properties.MetricName).toBe("5xx");
    expect(JSON.stringify(resources.Invoke.Properties.SourceArn)).toContain("/POST/clinical-core/workforce/encounter-recording/authority");
  });
  it("runs the actual bundled default-blocked handler without database configuration or AWS credentials", () => {
    const child = spawnSync(process.execPath, ["-e", "require('./dist/aws-clinical-core/recording-authority/index.js').handler({}).then(r=>console.log(JSON.stringify(r)))"], {
      encoding: "utf8", timeout: 10000, env: { ...process.env,
        WORKFORCE_ISSUER: "https://cognito-idp.us-east-2.amazonaws.com/FictionalWorkforce", WORKFORCE_AUDIENCE: "12345678901234567890",
        RECORDING_ORGANIZATION_ID: "11111111-1111-4111-8111-111111111111", PHI_ALLOWED: "false", RECORDING_AUTHORITY_ACTIVATION: "blocked",
        CLINICAL_DATABASE_CLUSTER_ARN: "", CLINICAL_DATABASE_SECRET_ARN: "", CLINICAL_DATABASE_NAME: "",
        AWS_EC2_METADATA_DISABLED: "true", AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "",
      },
    });
    expect(child.status, child.stderr).toBe(0);
    const response = JSON.parse(child.stdout); expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "production_not_activated", phiAllowed: false });
  });
});
