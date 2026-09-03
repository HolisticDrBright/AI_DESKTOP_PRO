import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getSyntheticClinicalCorePosture,
  issueSyntheticPatientInvitation,
} from "./synthetic-api-client";

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

  test("issues only a short-lived AWS invitation for a UUID test chart", async () => {
    process.env.CLINICAL_AWS_RUNTIME_MODE = "synthetic";
    process.env.CLINICAL_AWS_API_ORIGIN = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      invitationId: "10000000-0000-4000-8000-000000000001",
      connectionId: "20000000-0000-4000-8000-000000000001",
      expiresAt: "2026-09-03T12:00:00.000Z",
      token: "ABCDEFGHJKLMN",
    } }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(issueSyntheticPatientInvitation(
      token,
      "30000000-0000-4000-8000-000000000001",
    )).resolves.toMatchObject({ token: "ABCDEFGHJKLMN" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://wxv734oi12.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/invitations");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body).toEqual({
      patientRecordId: "30000000-0000-4000-8000-000000000001",
      expiresAt: expect.any(String),
    });
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
  });

  test("refuses malformed invitation responses and non-UUID chart identifiers", async () => {
    process.env.CLINICAL_AWS_RUNTIME_MODE = "synthetic";
    process.env.CLINICAL_AWS_API_ORIGIN = "https://wxv734oi12.execute-api.us-east-2.amazonaws.com";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      token: "made-up-code",
    } }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(issueSyntheticPatientInvitation(token, "not-a-uuid")).rejects.toMatchObject({
      code: "synthetic_clinical_core_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(issueSyntheticPatientInvitation(
      token,
      "30000000-0000-4000-8000-000000000001",
    )).rejects.toMatchObject({ code: "synthetic_clinical_core_unavailable" });
  });
});
