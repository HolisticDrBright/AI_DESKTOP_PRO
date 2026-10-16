import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Where sign-in leaves a practitioner under `database_current`, and what a second tab or a second account can do
// afterwards: the real sign-in, MFA, clinic list, switch and a fenced live route over the real transport. Only the
// cookie jar, request headers, Cognito and the network are faked. Fictional identifiers only.
const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
    getAll: (name?: string) => (name ? jar.cookies.filter((cookie) => cookie.name === name) : jar.cookies),
  }),
  headers: async () => jar.headers,
}));
const cognito = vi.hoisted(() => ({ passwordSignIn: vi.fn(), completeMfaSignIn: vi.fn() }));
vi.mock("@/adapters/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters/auth.server")>()),
  passwordSignIn: cognito.passwordSignIn,
  completeMfaSignIn: cognito.completeMfaSignIn,
}));

import { NextRequest } from "next/server";
import { POST as login } from "./login/route";
import { POST as mfa } from "./mfa/route";
import { GET as listClinics, POST as switchClinic } from "./org/route";
import { POST as labWorkspace } from "../live/labs/workspace/route";
import { afterSignInPath } from "@/lib/local-return-path";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const DISCOVERY = `${ORIGIN}/clinical-core/workforce/memberships/current`;
const clinicA = randomUUID(), clinicB = randomUUID(), subA = randomUUID(), subB = randomUUID(), patient = randomUUID();
const idToken = (sub: string) => [{ alg: "RS256", kid: "fictional" }, { sub, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const binding = (sub: string) => createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex");
const tabToken = (sub: string, organizationId: string) => "v1." + createHash("sha256")
  .update(`aidp-expected-clinic/1|${sub}|${organizationId}`).digest("base64url").slice(0, 32);
const clinic = (organizationId: string, name: string, role = "owner") => ({ organizationId, name, role });

type Discovery = { clinics: Array<{ organizationId: string; name: string; role: string }>; pending: Array<{ organizationId: string; name: string }> };
let discovered: Record<string, Discovery | number>;
let fetchMock: ReturnType<typeof vi.fn>;
const subjectOf = (init: RequestInit) => {
  const bearer = String(((init.headers ?? {}) as Record<string, string>).Authorization ?? "").replace(/^Bearer /, "");
  return JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")).sub as string;
};
const clinicalCalls = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).filter(([url]) => url !== DISCOVERY);
const sentClinic = (init: RequestInit) => Object.entries((init.headers ?? {}) as Record<string, string>)
  .filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value).join();

function session(sub: string, extra: Array<{ name: string; value: string }> = []) {
  jar.cookies = [{ name: "aidp_at", value: idToken(sub) }, { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: "fictional.practitioner@example.test" }, ...extra];
}
const selected = (organizationId: string, sub: string) => [{ name: "aidp_org", value: organizationId }, { name: "aidp_org_sub", value: binding(sub) }];
const tokens = (sub: string) => ({ accessToken: idToken(sub), refreshToken: "fictional-refresh", expiresAt: Date.now() + 3_600_000, email: "fictional.practitioner@example.test" });
const signInAs = (sub: string) => {
  cognito.passwordSignIn.mockResolvedValue(tokens(sub));
  return login(new NextRequest("https://desktop.example.test/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() },
    body: JSON.stringify({ email: "fictional.practitioner@example.test", password: "fictional-password" }),
  }));
};
const finishMfaAs = (sub: string) => {
  cognito.completeMfaSignIn.mockResolvedValue(tokens(sub));
  jar.cookies = [{ name: "aidp_mfa", value: "fictional-session" }, { name: "aidp_mfu", value: "fictional-user" },
    { name: "aidp_mfe", value: "fictional.practitioner@example.test" }, { name: "aidp_mfc", value: "SOFTWARE_TOKEN_MFA" }, ...selected(clinicA, subA)];
  return mfa(new NextRequest("https://desktop.example.test/api/auth/mfa", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify({ code: "123456" }),
  }));
};
const choose = (organizationId: string) => switchClinic(new NextRequest("https://desktop.example.test/api/auth/org", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId }),
}));
const workspace = () => labWorkspace(new NextRequest("https://desktop.example.test/api/live/labs/workspace", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: patient }) }));
const cookie = (response: Response, name: string) => response.headers.getSetCookie()
  .find((line) => line.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1);
/** What the browser holds after a response: its Set-Cookie lines applied to the jar. */
const apply = (response: Response) => {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const name = pair!.slice(0, pair!.indexOf("=")), value = pair!.slice(pair!.indexOf("=") + 1);
    jar.cookies = jar.cookies.filter((entry) => entry.name !== name);
    if (value && !/max-age=0/i.test(line)) jar.cookies.push({ name, value });
  }
};
const step = async (response: Response) => ((await response.json()) as { data?: { clinicStep?: unknown } }).data?.clinicStep;

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
    return new Response(JSON.stringify({ data: body.includes("patient_profiles") ? [{ first_name: "Fictional", last_name: "Patient" }] : [] }),
      { status: 200, headers: { [HEADER]: sentClinic(init) } });
  });
  vi.stubGlobal("fetch", fetchMock);
  cognito.passwordSignIn.mockReset(); cognito.completeMfaSignIn.mockReset();
  jar.headers = new Headers();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar.cookies = []; jar.headers = new Headers(); });

describe("where sign-in leaves the practitioner", () => {
  it("no active clinic goes to onboarding; one is selected; several wait for an explicit choice; an outage claims nothing", async () => {
    discovered[subA] = { clinics: [], pending: [{ organizationId: clinicA, name: "FICTIONAL PENDING" }] };
    let response = await signInAs(subA);
    expect(await step(response)).toBe("onboard");
    expect(cookie(response, "aidp_org")).toBe("");
    expect(afterSignInPath("onboard", "/patients")).toBe("/apply");

    discovered[subA] = { clinics: [clinic(clinicA, "FICTIONAL A")], pending: [] };
    response = await signInAs(subA);
    expect(await step(response)).toBe("selected");
    expect(cookie(response, "aidp_org")).toBe(clinicA);
    expect(afterSignInPath("selected", "/patients")).toBe("/patients");

    discovered[subA] = { clinics: [clinic(clinicA, "FICTIONAL A"), clinic(clinicB, "FICTIONAL B", "staff")], pending: [] };
    response = await signInAs(subA);
    expect(await step(response)).toBe("choose");
    expect(cookie(response, "aidp_org")).toBe("");
    expect(afterSignInPath("choose", "/patients")).toBe("/select-clinic?next=%2Fpatients");

    discovered[subA] = 503;
    response = await signInAs(subA);
    expect(await step(response)).toBe("unknown");
    expect(cookie(response, "aidp_org")).toBe("");
    expect(afterSignInPath("unknown", "/")).toBe("/select-clinic?next=%2F");
  });

  it("the MFA step reports the same, and rewrites the selection for the account that finished it", async () => {
    discovered[subB] = { clinics: [clinic(clinicA, "FICTIONAL A"), clinic(clinicB, "FICTIONAL B")], pending: [] };
    const response = await finishMfaAs(subB);
    expect(response.status).toBe(200);
    expect(await step(response)).toBe("choose");
    // The jar held subject A's choice of clinic A; it is cleared, not carried into B's session.
    expect(cookie(response, "aidp_org")).toBe("");
    expect(cookie(response, "aidp_org_sub")).toBe("");
  });

  it("the legacy default reports no step and keeps its own selection", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ organization_id: clinicA, name: "Legacy A", slug: "a", role: "practitioner" }] }), { status: 200 }));
    const response = await signInAs(subA);
    expect(await step(response)).toBeUndefined();
    expect(cookie(response, "aidp_org")).toBe(clinicA);
    expect(afterSignInPath(undefined, "/patients")).toBe("/patients");
  });
});

describe("after sign-in", () => {
  it("a clinic suspended during the session leaves the account's choices, cannot be chosen, and its selection serves nothing", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "FICTIONAL A"), clinic(clinicB, "FICTIONAL B")], pending: [] };
    session(subA, selected(clinicA, subA));
    expect(((await (await listClinics()).json()) as { data: { activeOrgId: unknown } }).data.activeOrgId).toBe(clinicA);
    // An operator suspends clinic A: the identity API's discovery no longer lists it.
    discovered[subA] = { clinics: [clinic(clinicB, "FICTIONAL B")], pending: [] };
    const listed = ((await (await listClinics()).json()) as { data: { organizations: Array<{ organizationId: string }>; activeOrgId: unknown } }).data;
    expect(listed.organizations.map((org) => org.organizationId)).toEqual([clinicB]);
    expect(listed.activeOrgId).toBeNull();
    const refused = await choose(clinicA);
    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie().some((line) => line.startsWith("aidp_org"))).toBe(false);
    // The next sign-in selects the one clinic left.
    const again = await signInAs(subA);
    expect(await step(again)).toBe("selected");
    expect(cookie(again, "aidp_org")).toBe(clinicB);
  });

  it("a second tab switches clinics through the real switch; the first tab's write under its old clinic is refused, unsent", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "FICTIONAL A"), clinic(clinicB, "FICTIONAL B")], pending: [] };
    session(subA, selected(clinicA, subA));
    jar.headers = new Headers({ "x-aidp-expected-clinic": tabToken(subA, clinicA) });
    expect((await workspace()).status).toBe(200);
    expect(clinicalCalls().every(([, init]) => sentClinic(init) === clinicA)).toBe(true);
    // Tab two chooses clinic B; the browser now holds that choice.
    const switched = await choose(clinicB);
    expect(switched.status).toBe(200);
    apply(switched);
    fetchMock.mockClear();
    // Tab one still carries the binding its page was rendered under.
    const stale = await workspace();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict", message: "Your clinic changed in another window. Reload to continue." } });
    expect(clinicalCalls()).toEqual([]);
    // Tab two, rendered under clinic B, is served in clinic B.
    jar.headers = new Headers({ "x-aidp-expected-clinic": tabToken(subA, clinicB) });
    expect((await workspace()).status).toBe(200);
    expect(clinicalCalls().length).toBeGreaterThan(0);
    expect(clinicalCalls().every(([, init]) => sentClinic(init) === clinicB)).toBe(true);
  });

  it("a second account on the same browser never inherits the first account's clinic, even before it signs in again", async () => {
    discovered[subA] = { clinics: [clinic(clinicA, "FICTIONAL A")], pending: [] };
    discovered[subB] = { clinics: [clinic(clinicA, "FICTIONAL A"), clinic(clinicB, "FICTIONAL B")], pending: [] };
    // B's token beside A's selection (a token swapped under the cookie): nothing is selected, nothing is sent.
    session(subB, selected(clinicA, subA));
    jar.headers = new Headers({ "x-aidp-expected-clinic": tabToken(subB, clinicA) });
    expect(((await (await listClinics()).json()) as { data: { activeOrgId: unknown } }).data.activeOrgId).toBeNull();
    const refused = await workspace();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(clinicalCalls()).toEqual([]);
    // B's own sign-in: B has two clinics, so B chooses; A's choice is cleared even though B is a member of clinic A.
    session(subA, selected(clinicA, subA));
    const signedIn = await signInAs(subB);
    expect(await step(signedIn)).toBe("choose");
    expect(cookie(signedIn, "aidp_org")).toBe("");
    expect(cookie(signedIn, "aidp_org_sub")).toBe("");
  });
});
