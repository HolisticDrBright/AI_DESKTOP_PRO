import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real lab workspace route, live-route helper, session, labs adapter and AWS clinical transport. Only the browser
// cookie jar, Cognito sign-in and the network are faked. Fictional identifiers only.
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
import { POST as labWorkspace } from "./labs/workspace/route";
import { POST as login } from "../auth/login/route";
import { POST as switchClinic } from "../auth/org/route";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const clinicA = randomUUID(), clinicB = randomUUID(), patient = randomUUID();
const subA = randomUUID(), subB = randomUUID();
const idToken = (sub: string) => [{ alg: "RS256", kid: "fictional" }, { sub, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
// The binding contract: SHA-256 of the domain and the subject, never the subject itself.
const binding = (sub: string) => createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex");

let fetchMock: ReturnType<typeof vi.fn>;
let reply: (url: string, init: RequestInit) => Response | Promise<Response>;
function session(sub: string, extra: Array<{ name: string; value: string }> = []) {
  jar.cookies = [
    { name: "aidp_at", value: idToken(sub) },
    { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: "fictional.practitioner@example.test" },
    ...extra,
  ];
}
const selected = (clinic: string, sub: string) => [{ name: "aidp_org", value: clinic }, { name: "aidp_org_sub", value: binding(sub) }];
const workspace = () => labWorkspace(new NextRequest("https://desktop.example.test/api/live/labs/workspace", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: patient }),
}));
const sent = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => ({
  url, init, headers: Object.entries((init.headers ?? {}) as Record<string, string>),
}));
const clinicHeaders = (call: ReturnType<typeof sent>[number]) => call.headers
  .filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value);

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
  reply = (_url, init) => new Response(JSON.stringify({ data: String(init.body).includes("patient_profiles")
    ? [{ first_name: "Fictional", last_name: "Patient" }] : [] }), { status: 200 });
  fetchMock = vi.fn(async (url: string, init: RequestInit) => reply(url, init));
  vi.stubGlobal("fetch", fetchMock);
  signIn.passwordSignIn.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); jar.cookies = []; });

describe("Desktop clinical requests carry the session's own selected clinic", () => {
  it("sends exactly one selected-clinic header, the session's bound selection, on every request a route makes", async () => {
    session(subA, selected(clinicA, subA));
    const response = await workspace();
    expect(response.status).toBe(200);
    expect(sent()).toHaveLength(3);
    for (const call of sent()) {
      expect(call.url).toBe(`${ORIGIN}/clinical-core/workforce/data-compatibility`);
      expect(clinicHeaders(call)).toEqual([clinicA]);
      expect(call.init.redirect).toBe("error");
    }
  });

  it("refuses a missing, malformed, duplicate or unbound selection before any request leaves the server", async () => {
    const cases: Array<Array<{ name: string; value: string }>> = [
      [],
      [{ name: "aidp_org", value: "not-a-clinic" }, { name: "aidp_org_sub", value: binding(subA) }],
      [...selected(clinicA, subA), { name: "aidp_org", value: clinicB }],
      [{ name: "aidp_org", value: clinicA }],
    ];
    for (const extra of cases) {
      session(subA, extra);
      const response = await workspace();
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never reuses another account's selection: a session for account B with account A's clinic refuses", async () => {
    session(subB, selected(clinicA, subA));
    expect((await workspace()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows a clinic switch made in another tab on the next request, never mixing the two clinics", async () => {
    session(subA, selected(clinicA, subA));
    await workspace();
    session(subA, selected(clinicB, subA));
    await workspace();
    const headers = sent().map(clinicHeaders);
    expect(headers.slice(0, 3)).toEqual([[clinicA], [clinicA], [clinicA]]);
    expect(headers.slice(3)).toEqual([[clinicB], [clinicB], [clinicB]]);
    // The clinic each operation names is the clinic in the header.
    for (const call of sent().slice(3)) expect(String(call.init.body)).not.toContain(clinicA);
  });

  it("reports revoked membership and a server error as refusals, with no retry under another clinic or none", async () => {
    session(subA, selected(clinicA, subA));
    reply = () => new Response(JSON.stringify({ error: "production_boundary_refused" }), { status: 403 });
    expect((await workspace()).status).toBe(403);
    reply = () => new Response(JSON.stringify({ error: "database_unavailable" }), { status: 503 });
    expect((await workspace()).status).toBe(503);
    expect(sent().map(clinicHeaders).every((values) => values.length === 1 && values[0] === clinicA)).toBe(true);
    expect(sent()).toHaveLength(6);
  });

  it("does not follow a redirect and does not log the clinic, the subject or the token", async () => {
    const logged: string[] = [];
    for (const level of ["error", "warn", "log", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    session(subA, selected(clinicA, subA));
    reply = () => { throw new TypeError("fetch failed: unexpected redirect"); };
    expect((await workspace()).status).toBe(503);
    session(subB, selected(clinicA, subA));
    expect((await workspace()).status).toBe(400);
    const text = logged.join("\n");
    for (const secret of [clinicA, subA, subB, idToken(subA), binding(subA)]) expect(text).not.toContain(secret);
  });

  it("leaves legacy requests unchanged: no selected-clinic header and no new refusal", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    session(subA, [{ name: "aidp_org", value: clinicA }]);
    expect((await workspace()).status).toBe(200);
    expect(sent()).toHaveLength(3);
    for (const call of sent()) expect(clinicHeaders(call)).toEqual([]);
  });
});

describe("the selection is written for the account that made it", () => {
  const signInRequest = () => new NextRequest("https://desktop.example.test/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": randomUUID() },
    body: JSON.stringify({ email: "fictional.practitioner@example.test", password: "fictional-password" }),
  });
  const setCookies = (response: Response) => response.headers.getSetCookie();
  const cookieValue = (response: Response, name: string) => setCookies(response)
    .find((line) => line.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1);

  it("clears the previous account's clinic when a new sign-in cannot determine one", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    session(subA, selected(clinicA, subA));
    signIn.passwordSignIn.mockResolvedValue({ accessToken: idToken(subB), refreshToken: "fictional-refresh", expiresAt: Date.now() + 3_600_000,
      email: "second.practitioner@example.test" });
    reply = () => new Response(JSON.stringify({ error: "database_unavailable" }), { status: 503 });
    const response = await login(signInRequest());
    expect(response.status).toBe(200);
    expect(cookieValue(response, "aidp_org")).toBe("");
    expect(cookieValue(response, "aidp_org_sub")).toBe("");
  });

  it("binds a sign-in's clinic to the subject of the token it was chosen with", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    signIn.passwordSignIn.mockResolvedValue({ accessToken: idToken(subB), refreshToken: "fictional-refresh", expiresAt: Date.now() + 3_600_000,
      email: "second.practitioner@example.test" });
    reply = (url, init) => new Response(JSON.stringify({ data: String(init.body).includes("list_my_organizations")
      ? [{ organization_id: clinicB, name: "Fictional B", slug: "fictional-b", role: "practitioner" }] : [] }), { status: 200 });
    const response = await login(signInRequest());
    expect(cookieValue(response, "aidp_org")).toBe(clinicB);
    expect(cookieValue(response, "aidp_org_sub")).toBe(binding(subB));
  });

  it("checks a clinic switch against the account's current clinics, never by asking with the clinic being chosen", async () => {
    session(subA, selected(clinicA, subA));
    const discovery = `${ORIGIN}/clinical-core/workforce/memberships/current`;
    reply = (url) => url === discovery
      ? new Response(JSON.stringify({ data: { clinics: [{ organizationId: clinicA, name: "A", role: "practitioner" },
        { organizationId: clinicB, name: "B", role: "staff" }], pending: [] } }), { status: 200 })
      : new Response(JSON.stringify({ error: "production_boundary_refused" }), { status: 403 });
    const switched = await switchClinic(new NextRequest("https://desktop.example.test/api/auth/org", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: clinicB }),
    }));
    expect(switched.status).toBe(200);
    expect(sent().map((call) => call.url)).toEqual([discovery]);
    expect(sent().map(clinicHeaders)).toEqual([[]]);
    expect(cookieValue(switched, "aidp_org")).toBe(clinicB);
    expect(cookieValue(switched, "aidp_org_sub")).toBe(binding(subA));
    // A clinic this person is not a member of is refused, nothing is written, and it was never sent as a selection.
    const other = randomUUID();
    const refused = await switchClinic(new NextRequest("https://desktop.example.test/api/auth/org", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: other }),
    }));
    expect(refused.status).toBe(403);
    expect(setCookies(refused).some((line) => line.startsWith("aidp_org"))).toBe(false);
    expect(JSON.stringify(sent())).not.toContain(other);
  });
});
