import { describe, expect, test } from "vitest";
import { inspectAwsProductionRuntime } from "./awsProductionGate";

const base = {
  APP_RUNTIME_ENV: "production-clinical",
  CLINICAL_DATA_PLANE: "aws_production",
  CLINICAL_COMPUTE: "ecs_fargate",
  CLINICAL_AWS_REGION: "us-east-2",
  CLINICAL_AWS_API_ORIGIN: "https://clinical.example.com",
  CLINICAL_AWS_ALLOWED_API_HOSTS: "clinical.example.com",
  CLINICAL_AWS_WORKFORCE_USER_POOL_ID: "us-east-2_workforce",
  CLINICAL_AWS_WORKFORCE_CLIENT_ID: "workforce-client",
  CLINICAL_AWS_CONSUMER_USER_POOL_ID: "us-east-2_consumer",
  CLINICAL_AWS_CONSUMER_CLIENT_ID: "consumer-client",
  AWS_CLINICAL_ADAPTER_READY: "true",
  PHI_ALLOWED: "false",
};

describe("AWS production runtime gate", () => {
  test("does not alter a staging or local runtime", () => {
    expect(inspectAwsProductionRuntime({ APP_RUNTIME_ENV: "staging" })).toEqual({
      active: false, ready: true, phiAllowed: false, blockers: [],
    });
  });

  test("permits AWS-only synthetic production validation", () => {
    expect(inspectAwsProductionRuntime(base)).toEqual({ active: true, ready: true, phiAllowed: false, blockers: [] });
  });

  test("refuses legacy Supabase credentials and non-Fargate compute", () => {
    const report = inspectAwsProductionRuntime({ ...base, CLINICAL_COMPUTE: "app_runner", CLINICAL_SUPABASE_URL: "https://legacy.supabase.co" });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining(["CLINICAL_COMPUTE", "forbidden:CLINICAL_SUPABASE_URL"]));
  });

  test("refuses PHI without an approval and immutable evidence hash", () => {
    const report = inspectAwsProductionRuntime({ ...base, PHI_ALLOWED: "true" });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining(["PHI_ACTIVATION", "PRODUCTION_READINESS_EVIDENCE_SHA256"]));
  });

  test("accepts PHI only after both activation controls are present", () => {
    const report = inspectAwsProductionRuntime({
      ...base,
      PHI_ALLOWED: "true",
      PHI_ACTIVATION: "approved",
      PRODUCTION_READINESS_EVIDENCE_SHA256: "a".repeat(64),
    });
    expect(report).toEqual({ active: true, ready: true, phiAllowed: true, blockers: [] });
  });
});
