import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTelehealthRuntimeMode } from "./telehealth-lambda-environment";

const createTelehealthHandler = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("./aws-telehealth-requests", () => ({ createTelehealthHandler }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  createTelehealthHandler.mockClear();
});

describe("telehealth Lambda runtime posture", () => {
  it("accepts only the two declared runtime modes", () => {
    expect(parseTelehealthRuntimeMode("synthetic")).toBe("synthetic");
    expect(parseTelehealthRuntimeMode("production")).toBe("production");
    for (const value of ["", "staging", "Production", "false", "synthetic "]) {
      expect(() => parseTelehealthRuntimeMode(value)).toThrow("telehealth_configuration_invalid");
    }
  });

  it("refuses an invalid deployed mode before creating the Lambda handler", async () => {
    for (const name of [
      "TELEHEALTH_TABLE_NAME", "CLINICAL_CONSUMER_ISSUER", "CLINICAL_CONSUMER_AUDIENCE",
      "CLINICAL_WORKFORCE_ISSUER", "CLINICAL_WORKFORCE_AUDIENCE", "PHI_ALLOWED",
      "ZOOM_ENABLED", "ZOOM_BAA_VERIFIED", "REMINDERS_ENABLED", "STRIPE_TEST_ENABLED",
      "CLINICAL_API_ORIGIN",
    ]) vi.stubEnv(name, "fictional-test-value");
    vi.stubEnv("RUNTIME_MODE", "staging");

    await expect(import("./aws-telehealth-requests-lambda")).rejects.toThrow("telehealth_configuration_invalid");
    expect(createTelehealthHandler).not.toHaveBeenCalled();
  });
});
