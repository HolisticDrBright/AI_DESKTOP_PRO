import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeRuntimePosture } from "./posture";

const KEYS = [
  "CLINICAL_AWS_WORKFORCE_API_ORIGIN",
  "CLINICAL_CONTRACT_FIXTURE",
  "CLINICAL_SUPABASE_URL",
  "APP_EDITION",
  "NEXT_PUBLIC_USE_LIVE_API",
  "NODE_ENV",
] as const;

function reset() {
  for (const key of KEYS) delete process.env[key];
}

function setEnv(key: string, value: string): void {
  (process.env as Record<string, string>)[key] = value;
}

describe("runtime posture — PHI-safe fields only", () => {
  beforeEach(reset);
  afterEach(reset);

  test("an approved API Gateway origin emits only its bounded API id and host", () => {
    process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN =
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
    process.env.APP_EDITION = "clinical";
    process.env.NEXT_PUBLIC_USE_LIVE_API = "true";
    const posture = describeRuntimePosture();
    expect(posture.transport).toBe("aws_api_gateway");
    expect(posture.clinical_api_id).toBe("abcdefghij");
    expect(posture.clinical_api_host).toBe("abcdefghij.execute-api.us-east-2.amazonaws.com");
    expect(posture.app_edition).toBe("clinical");
    expect(posture.live_mode).toBe(true);
  });

  test("the explicit loopback harness emits fixture without exposing its origin", () => {
    setEnv("NODE_ENV", "development");
    process.env.CLINICAL_CONTRACT_FIXTURE = "1";
    process.env.CLINICAL_SUPABASE_URL = "http://127.0.0.1:3999";
    const posture = describeRuntimePosture();
    expect(posture.transport).toBe("fixture");
    expect(posture.clinical_api_host).toBeNull();
    expect(posture.clinical_api_id).toBeNull();
  });

  test("missing or unapproved origins emit unknown without throwing", () => {
    expect(describeRuntimePosture().transport).toBe("unknown");
    process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN = "https://example.com/path";
    expect(describeRuntimePosture()).toMatchObject({
      transport: "unknown",
      clinical_api_host: null,
      clinical_api_id: null,
    });
  });

  test("live_mode is false unless explicitly true", () => {
    process.env.NEXT_PUBLIC_USE_LIVE_API = "1";
    expect(describeRuntimePosture().live_mode).toBe(false);
    process.env.NEXT_PUBLIC_USE_LIVE_API = "yes";
    expect(describeRuntimePosture().live_mode).toBe(false);
  });

  test("emitted object carries no key material or credential fields", () => {
    process.env.CLINICAL_AWS_WORKFORCE_API_ORIGIN =
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
    process.env.CLINICAL_SUPABASE_ANON_KEY = "fixture-secret";
    const json = JSON.stringify(describeRuntimePosture());
    expect(json).not.toContain("fixture-secret");
    expect(json).not.toContain("anon_key");
    expect(json).not.toContain("service_role");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("cookie");
  });
});
