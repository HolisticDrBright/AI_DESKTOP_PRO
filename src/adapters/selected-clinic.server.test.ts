import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clinicalLabSpecimenContext, clinicalRpc, clinicalSelect } from "./aws-clinical-data.server";
import { clinicalAuthorityMode, tokenSubject, withSelectedClinic, type SelectedClinic } from "./selected-clinic.server";
import { resolveSelectedClinic, subjectBinding } from "@/server/selected-clinic-binding";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const sub = randomUUID(), clinicA = randomUUID(), clinicB = randomUUID();
const token = (subject: string) => [{ alg: "RS256" }, { sub: subject, token_use: "id" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional";
const selected = (organizationId: string, subject = sub): SelectedClinic =>
  ({ state: "selected", organizationId, subject });
let fetchMock: ReturnType<typeof vi.fn>;
const headerOf = (index: number) => Object.entries((fetchMock.mock.calls[index]![1] as RequestInit).headers as Record<string, string>)
  .filter(([key]) => key.toLowerCase() === "x-alp-selected-organization-id").map(([, value]) => value);

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("selected-clinic resolution", () => {
  it("binds a selection to the token's subject and refuses every ambiguous or foreign form", () => {
    const bound = subjectBinding(token(sub))!;
    expect(bound).toBe(createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex"));
    expect(bound).not.toContain(sub);
    const resolve = (organizationCookies: string[], bindingCookies: string[], t: string | null = token(sub)) =>
      resolveSelectedClinic({ organizationCookies, bindingCookies, token: t }).state;
    expect(resolve([clinicA.toUpperCase()], [bound])).toBe("selected");
    expect(resolveSelectedClinic({ organizationCookies: [clinicA.toUpperCase()], bindingCookies: [bound], token: token(sub) }))
      .toEqual({ state: "selected", organizationId: clinicA, subject: sub });
    expect(resolve([], [bound])).toBe("missing");
    expect(resolve([clinicA, clinicB], [bound])).toBe("duplicate");
    expect(resolve([clinicA], [bound, bound])).toBe("duplicate");
    expect(resolve(["clinic-a"], [bound])).toBe("malformed");
    expect(resolve([clinicA], [])).toBe("unbound");
    expect(resolve([clinicA], ["not-a-digest"])).toBe("unbound");
    expect(resolve([clinicA], [bound], token(randomUUID()))).toBe("account_mismatch");
    expect(resolve([clinicA], [bound], "not.a.jwt")).toBe("account_mismatch");
    expect(resolve([clinicA], [bound], null)).toBe("account_mismatch");
    expect(subjectBinding(token("not-a-uuid"))).toBeNull();
    expect(tokenSubject(token(sub.toUpperCase()))).toBe(sub);
    expect(tokenSubject("a.%%%.c")).toBeNull();
  });

  it("only database_current selects the new behaviour; anything else is the legacy default", () => {
    for (const value of ["", "legacy_claims", "DATABASE_CURRENT", "database_current "]) {
      vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", value);
      expect(clinicalAuthorityMode()).toBe("legacy_claims");
    }
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
    expect(clinicalAuthorityMode()).toBe("database_current");
  });
});

describe("the AWS clinical transport under database_current", () => {
  it("keeps two concurrent requests' clinics apart in one server process", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fetchMock.mockImplementation(async () => { await gate; return new Response(JSON.stringify({ data: [] }), { status: 200 }); });
    const first = withSelectedClinic(selected(clinicA), async () => {
      const pending = clinicalRpc("list_my_organizations", {}, token(sub));
      await Promise.resolve();
      return pending;
    });
    const second = withSelectedClinic(selected(clinicB), () => clinicalRpc("list_my_organizations", {}, token(sub)));
    release();
    await Promise.all([first, second]);
    expect([headerOf(0), headerOf(1)].sort()).toEqual([[clinicA], [clinicB]].sort());
  });

  it("refuses work that names a clinic other than the selection, before the network", async () => {
    await expect(withSelectedClinic(selected(clinicB), () =>
      clinicalRpc("list_patient_lab_observations", { _organization_id: clinicA, _patient_id: randomUUID() }, token(sub))))
      .rejects.toMatchObject({ code: "conflict", detail: "clinic_selection_changed" });
    await expect(withSelectedClinic(selected(clinicB), () =>
      clinicalSelect("patient_profiles", new URLSearchParams({ organization_id: `eq.${clinicA}` }), token(sub))))
      .rejects.toMatchObject({ code: "conflict" });
    expect(fetchMock).not.toHaveBeenCalled();
    await withSelectedClinic(selected(clinicB), () =>
      clinicalRpc("list_patient_lab_observations", { _organization_id: clinicB.toUpperCase(), _patient_id: randomUUID() }, token(sub)));
    expect(headerOf(0)).toEqual([clinicB]);
  });

  it("refuses outside any request context and for another account's token, before the network", async () => {
    await expect(clinicalRpc("list_my_organizations", {}, token(sub))).rejects.toMatchObject({ code: "invalid", detail: "clinic_selection_unavailable" });
    await expect(withSelectedClinic(selected(clinicA), () => clinicalRpc("list_my_organizations", {}, token(randomUUID()))))
      .rejects.toMatchObject({ code: "invalid", detail: "clinic_selection_account_mismatch" });
    for (const state of ["missing", "malformed", "duplicate", "unbound", "account_mismatch"] as const) {
      await expect(withSelectedClinic({ state }, () => clinicalRpc("list_my_organizations", {}, token(sub))))
        .rejects.toMatchObject({ code: "invalid", detail: `clinic_selection_${state}` });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries the same selection on the separately governed specimen-context read", async () => {
    const patientId = randomUUID(), observationId = randomUUID(), eventId = randomUUID();
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ data: [{ id: observationId, import_event_id: eventId, observed_at: "2026-10-01T00:00:00Z" }] }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ data: null }), { status: 200 }));
    await withSelectedClinic(selected(clinicA), () => clinicalLabSpecimenContext({ patientId, observationId, eventId }, clinicA, token(sub)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([headerOf(0), headerOf(1)]).toEqual([[clinicA], [clinicA]]);
    await expect(withSelectedClinic(selected(clinicA), () => clinicalLabSpecimenContext({ patientId, observationId, eventId }, clinicB, token(sub))))
      .rejects.toMatchObject({ code: "conflict" });
  });
});
