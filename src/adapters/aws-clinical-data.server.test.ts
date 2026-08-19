import { afterEach, describe, expect, test, vi } from "vitest";
import { clinicalRpc, clinicalSelect } from "./aws-clinical-data.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AWS clinical compatibility transport", () => {
  test("sends a Cognito bearer and structured operation to the AWS API", async () => {
    vi.stubEnv(
      "CLINICAL_AWS_WORKFORCE_API_ORIGIN",
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "synthetic-1" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(clinicalSelect<Array<{ id: string }>>(
      "patients",
      new URLSearchParams({ select: "id", limit: "1" }),
      "cognito-token",
    )).resolves.toEqual([{ id: "synthetic-1" }]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com/clinical-core/workforce/data-compatibility",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer cognito-token" });
    expect(init.headers).not.toHaveProperty("apikey");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "select",
      table: "patients",
      query: "select=id&limit=1",
    });
  });

  test("RPC arguments use the same governed AWS envelope", async () => {
    vi.stubEnv(
      "CLINICAL_AWS_WORKFORCE_API_ORIGIN",
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await clinicalRpc("accept_synthetic_lab", { importId: "test" }, "cognito-token");
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      kind: "rpc",
      functionName: "accept_synthetic_lab",
      args: { importId: "test" },
    });
  });

  test("missing token and non-API-Gateway origins refuse before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(clinicalRpc("anything", {}, null)).rejects.toMatchObject({ code: "unauthenticated" });

    vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", "https://example.com");
    await expect(clinicalRpc("anything", {}, "token")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("malformed AWS success envelopes refuse instead of fabricating data", async () => {
    vi.stubEnv(
      "CLINICAL_AWS_WORKFORCE_API_ORIGIN",
      "https://abcdefghij.execute-api.us-east-2.amazonaws.com",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "not-enveloped" }]), { status: 200 }),
    ));
    await expect(clinicalRpc("anything", {}, "token")).rejects.toMatchObject({ code: "unknown" });
  });
});
