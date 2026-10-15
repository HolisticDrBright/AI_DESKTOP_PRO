import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Desktop caller of the telehealth boundary: the real adapter, with only the network faked. Fictional identifiers.
vi.mock("./session.server", () => ({ getClinicalAccessToken: async (token: string | null) => token ?? "" }));
vi.mock("@/server/runtime/contractFixture", () => ({ getContractFixtureTransport: () => null }));

import { telehealthLive } from "./telehealth.live";
import { telehealthRequestsLive } from "./telehealth-requests.live";
import { subjectBinding, withSelectedClinic, type SelectedClinic } from "./selected-clinic.server";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const sub = randomUUID(), clinic = randomUUID();
const token = (subject: string) => [{ alg: "RS256" }, { sub: subject, token_use: "id" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional";
const selected = (organizationId: string): SelectedClinic => ({ state: "selected", organizationId, binding: subjectBinding(token(sub))! });
const artifact = { artifactId: randomUUID(), artifactVersion: "telehealth-recording/1", contentSha256: "b".repeat(64), jurisdiction: "US-CA",
  approvedAt: "2026-10-01T00:00:00.000Z", scope: "telehealth_recording" };
let fetchMock: ReturnType<typeof vi.fn>;
const clinicHeaders = (index: number) => Object.entries((fetchMock.mock.calls[index]![1] as RequestInit).headers as Record<string, string>)
  .filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value);

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: artifact }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the telehealth boundary's Desktop caller", () => {
  it("sends the session's one selected clinic under database_current, and never follows a redirect", async () => {
    await withSelectedClinic(selected(clinic), () => telehealthLive.consentArtifact(token(sub)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clinicHeaders(0)).toEqual([clinic]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });

  it("refuses a missing selection or another account's token before calling the boundary", async () => {
    await expect(withSelectedClinic(undefined, () => telehealthLive.consentArtifact(token(sub))))
      .rejects.toMatchObject({ code: "invalid", detail: "clinic_selection_missing" });
    await expect(withSelectedClinic(selected(clinic), () => telehealthLive.consentArtifact(token(randomUUID()))))
      .rejects.toMatchObject({ code: "invalid", detail: "clinic_selection_account_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a disabled telehealth write as unavailable, distinct from a refusal or an outage", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "membership_fence_unavailable" }), { status: 503 }));
    await expect(withSelectedClinic(selected(clinic), () => telehealthLive.consentArtifact(token(sub)))).rejects.toMatchObject({
      code: "unavailable",
      message: "This telehealth change is not available yet under clinic-membership sign-in. Reading visits still works.",
    });
  });

  it("sends the same selection from the appointment-request queue, whose body never names a clinic", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await withSelectedClinic(selected(clinic), async () => {
      await telehealthRequestsLive.list(token(sub));
      await telehealthRequestsLive.listSlots(token(sub));
      await telehealthRequestsLive.action(token(sub), { requestId: randomUUID(), action: "cancel", expectedVersion: 1 });
    });
    expect([0, 1, 2].map(clinicHeaders)).toEqual([[clinic], [clinic], [clinic]]);
    await expect(withSelectedClinic(undefined, () => telehealthRequestsLive.list(token(sub)))).rejects.toMatchObject({ code: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends nothing new under the legacy default", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    await telehealthLive.consentArtifact(token(sub));
    await telehealthRequestsLive.listSlots(token(sub));
    expect([clinicHeaders(0), clinicHeaders(1)]).toEqual([[], []]);
  });
});
