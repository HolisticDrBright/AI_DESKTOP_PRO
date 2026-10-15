import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Choosing a first clinic under `database_current`: the real sign-in, clinic list, switch and auto-select routes over
// the real transport, with only the cookie jar, Cognito sign-in and the network faked. Fictional identifiers only.
const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
    getAll: (name?: string) => (name ? jar.cookies.filter((cookie) => cookie.name === name) : jar.cookies),
  }),
}));
const signIn = vi.hoisted(() => ({ passwordSignIn: vi.fn() }));
vi.mock("@/adapters/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters/auth.server")>()),
  passwordSignIn: signIn.passwordSignIn,
}));

import { NextRequest } from "next/server";
import { POST as login } from "./login/route";
import { GET as listClinics, POST as switchClinic } from "./org/route";
import { GET as autoSelect } from "./org/auto/route";
import { POST as labWorkspace } from "../live/labs/workspace/route";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const DISCOVERY = `${ORIGIN}/clinical-core/workforce/memberships/current`;
const clinicA = randomUUID(), clinicB = randomUUID(), subA = randomUUID(), subB = randomUUID(), patient = randomUUID();
const idToken = (sub: string) => [{ alg: "RS256", kid: "fictional" }, { sub, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const binding = (sub: string) => createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex");
const clinic = (organizationId: string, name: string, role = "practitioner") => ({ organizationId, name, role });

type Discovery = { clinics: Array<{ organizationId: string; name: string; role: string }>; pending: Array<{ organizationId: string; name: string }> };
/** What the fictional identity API's discovery answers, per Cognito subject. */
let discovered: Record<string, Discovery | number>;
let fetchMock: ReturnType<typeof vi.fn>;
const subjectOf = (init: RequestInit) => {
  const bearer = String(((init.headers ?? {}) as Record<string, string>).Authorization ?? "").replace(/^Bearer /, "");
  return JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")).sub as string;
};
const headerValues = (init: RequestInit) => Object.entries((init.headers ?? {}) as Record<string, string>)
  .filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value);
const discoveryCalls = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([url]) => url === DISCOVERY);

function session(sub: string, extra: Array<{ name: string; value: string }> = []) {
  jar.cookies = [
    { name: "aidp_at", value: idToken(sub) },
    { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: "fictional.practitioner@example.test" },
    ...extra,
  ];
}
const selected = (organizationId: string, sub: string) => [{ name: "aidp_org", value: organizationId }, { name: "aidp_org_sub", value: binding(sub) }];
const signInAs = (sub: string) => {
  signIn.passwordSignIn.mockResolvedValue({ accessToken: idToken(sub), refreshToken: "fictional-refresh", expiresAt: Date.now() + 3_600_000,
    email: "fictional.practitioner@example.test" });
  return login(new NextRequest("https://desktop.example.test/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() },
    body: JSON.stringify({ email: "fictional.practitioner@example.test", password: "fictional-password" }),
  }));
};
const choose = (organizationId: string) => switchClinic(new NextRequest("https://desktop.example.test/api/auth/org", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }),
}));
const cookie = (response: Response, name: string) => response.headers.getSetCookie()
  .find((line) => line.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1);
const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown>; error?: Record<string, unknown> };

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
  vi.stubEnv("NEXT_PUBLIC_USE_LIVE_API", "true");
  discovered = {};
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === DISCOVERY) {
      const answer = discovered[subjectOf(init)];
      if (answer === undefined) return new Response(JSON.stringify({ error: "production_boundary_refused" }), { status: 403 });
      if (typeof answer === "number") return new Response(JSON.stringify({ error: "database_unavailable" }), { status: answer });
      return new Response(JSON.stringify({ data: answer }), { status: 200 });
    }
    const body = String(init.body ?? "");
    if (body.includes("list_my_organizations")) {
      return new Response(JSON.stringify({ data: [{ organization_id: clinicA, name: "Legacy A", slug: "a", role: "practitioner" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: body.includes("patient_profiles") ? [{ first_name: "Fictional", last_name: "Patient" }] : [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  signIn.passwordSignIn.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar.cookies = []; });

describe("choosing a first clinic under database_current", () => {
  it("first sign-in: discovers the account's one clinic without any selection and binds it to that account", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "Fictional A")], pending: [] };
    const response = await signInAs(subA);
    expect(response.status).toBe(200);
    expect(cookie(response, "aidp_org")).toBe(clinicA);
    expect(cookie(response, "aidp_org_sub")).toBe(binding(subA));
    expect(discoveryCalls()).toHaveLength(1);
    expect(headerValues(discoveryCalls()[0]![1])).toEqual([]);
    expect(discoveryCalls()[0]![1].redirect).toBe("error");
  });

  it("no memberships: signs in with no clinic, and the list says so rather than inventing one", async () => {
    discovered[subA] = { clinics: [], pending: [] };
    const response = await signInAs(subA);
    expect(response.status).toBe(200);
    expect(cookie(response, "aidp_org")).toBe("");
    expect(cookie(response, "aidp_org_sub")).toBe("");
    session(subA);
    expect((await json(await listClinics())).data).toEqual({ mode: "live", organizations: [], activeOrgId: null, pending: [] });
  });

  it("an unknown or unverifiable identity, or an outage, selects nothing and never falls back to a claim", async () => {
    for (const answer of [undefined, 503] as const) {
      if (answer === undefined) delete discovered[subA]; else discovered[subA] = answer;
      const response = await signInAs(subA);
      expect(response.status).toBe(200);
      expect(cookie(response, "aidp_org")).toBe("");
    }
    expect((fetchMock.mock.calls as Array<[string, RequestInit]>).some(([, init]) => String(init.body ?? "").includes("list_my_organizations"))).toBe(false);
  });

  it("pending membership: listed apart, not selectable, and nothing is written", async () => {
    discovered[subA] = { clinics: [], pending: [{ organizationId: clinicA, name: "Fictional A" }] };
    expect(cookie(await signInAs(subA), "aidp_org")).toBe("");
    session(subA);
    expect((await json(await listClinics())).data).toEqual({ mode: "live", organizations: [], activeOrgId: null,
      pending: [{ organizationId: clinicA, name: "Fictional A" }] });
    const refused = await choose(clinicA);
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toMatchObject({ message: "Your membership at that clinic is awaiting approval." });
    expect(refused.headers.getSetCookie().some((line) => line.startsWith("aidp_org"))).toBe(false);
  });

  it("multiple memberships: no clinic is chosen for the practitioner; their choice is bound and then used", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "Fictional A"), clinic(clinicB, "Fictional B", "staff")], pending: [] };
    expect(cookie(await signInAs(subA), "aidp_org")).toBe("");
    session(subA);
    const listed = (await json(await listClinics())).data!;
    expect((listed.organizations as Array<{ organizationId: string }>).map((org) => org.organizationId)).toEqual([clinicA, clinicB]);
    expect(listed.activeOrgId).toBeNull();
    const auto = await autoSelect(new NextRequest("https://desktop.example.test/api/auth/org/auto?next=/patients"));
    expect(auto.headers.get("location")).toBe("/settings#practice-preferences");
    const chosen = await choose(clinicB);
    expect(chosen.status).toBe(200);
    expect(cookie(chosen, "aidp_org")).toBe(clinicB);
    expect(cookie(chosen, "aidp_org_sub")).toBe(binding(subA));
    // Every discovery call carried no selection, even with one present.
    expect(discoveryCalls().every(([, init]) => headerValues(init).length === 0)).toBe(true);
    session(subA, selected(clinicB, subA));
    fetchMock.mockClear();
    await labWorkspace(new NextRequest("https://desktop.example.test/api/live/labs/workspace", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: patient }) }));
    const clinical = (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([url]) => url !== DISCOVERY);
    expect(clinical.length).toBeGreaterThan(0);
    expect(clinical.every(([, init]) => headerValues(init).join() === clinicB)).toBe(true);
  });

  it("revocation: a clinic that leaves the account's discovery is no longer active or choosable", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "Fictional A")], pending: [] };
    session(subA, selected(clinicA, subA));
    expect((await json(await listClinics())).data!.activeOrgId).toBe(clinicA);
    discovered[subA] = { clinics: [], pending: [] };
    expect((await json(await listClinics())).data!.activeOrgId).toBeNull();
    const refused = await choose(clinicA);
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie().some((line) => line.startsWith("aidp_org"))).toBe(false);
  });

  it("account switch: the new account's own clinics decide; the previous account's selection is replaced, not reused", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "Fictional A")], pending: [] };
    discovered[subB] = { clinics: [clinic(clinicB, "Fictional B")], pending: [] };
    session(subA, selected(clinicA, subA));
    const switched = await signInAs(subB);
    expect(cookie(switched, "aidp_org")).toBe(clinicB);
    expect(cookie(switched, "aidp_org_sub")).toBe(binding(subB));
    expect(discoveryCalls().map(([, init]) => subjectOf(init))).toEqual([subB]);
    // With no clinic for the new account, the old one is cleared.
    discovered[subB] = { clinics: [], pending: [] };
    session(subA, selected(clinicA, subA));
    const empty = await signInAs(subB);
    expect(cookie(empty, "aidp_org")).toBe("");
    expect(cookie(empty, "aidp_org_sub")).toBe("");
  });

  it("a clinic outside the account's discovery is refused even when the request names it", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "Fictional A")], pending: [] };
    session(subA);
    const refused = await choose(clinicB);
    expect(refused.status).toBe(403);
    expect(discoveryCalls().every(([, init]) => headerValues(init).length === 0)).toBe(true);
  });
});

describe("the legacy default", () => {
  it("signs in through list_my_organizations as before and never calls discovery", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    const response = await signInAs(subA);
    expect(cookie(response, "aidp_org")).toBe(clinicA);
    expect(discoveryCalls()).toEqual([]);
    session(subA, selected(clinicA, subA));
    const listed = (await json(await listClinics())).data!;
    expect(listed).not.toHaveProperty("pending");
    expect(discoveryCalls()).toEqual([]);
  });
});
