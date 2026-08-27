import { afterEach, describe, expect, test, vi } from "vitest";
import { getSyntheticClinicalCorePosture } from "./synthetic-api-client";

const token = `ey.${"a".repeat(140)}.sig`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLINICAL_AWS_RUNTIME_MODE;
  delete process.env.CLINICAL_AWS_API_ORIGIN;
});

describe("Desktop synthetic clinical-core client", () => {
  test("is disabled unless synthetic mode and the exact API Gateway origin are configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSyntheticClinicalCorePosture("workforce", token)).rejects.toMatchObject({
      code: "synthetic_clinical_core_unavailable",
    });
    process.env.CLINICAL_AWS_RUNTIME_MODE = "synthetic";
    process.env.CLINICAL_AWS_API_ORIGIN = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com.evil.example";
    await expect(getSyntheticClinicalCorePosture("workforce", token)).rejects.toMatchObject({
      code: "synthetic_clinical_core_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("accepts only the authenticated workforce synthetic posture", async () => {
    process.env.CLINICAL_AWS_RUNTIME_MODE = "synthetic";
    process.env.CLINICAL_AWS_API_ORIGIN = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      contractVersion: "clinical-core/1",
      environment: "synthetic-staging",
      dataClassification: "synthetic_only",
      identityPool: "workforce",
      authenticated: true,
      phiAllowed: false,
      realPatientDataAllowed: false,
    } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getSyntheticClinicalCorePosture("workforce", token)).resolves.toMatchObject({ authenticated: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://wxv734oi12.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/posture",
      expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store" }),
    );
  });

  test("refuses wrong-pool or widened posture claims", async () => {
    process.env.CLINICAL_AWS_RUNTIME_MODE = "synthetic";
    process.env.CLINICAL_AWS_API_ORIGIN = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      contractVersion: "clinical-core/1", environment: "synthetic-staging", dataClassification: "synthetic_only",
      identityPool: "consumer", authenticated: true, phiAllowed: true, realPatientDataAllowed: false,
    } }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(getSyntheticClinicalCorePosture("workforce", token)).rejects.toMatchObject({
      code: "synthetic_clinical_core_unavailable",
    });
  });
});
