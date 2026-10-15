import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stale-tab clinic fence: the real live routes, runLive, the session, the adapters and the AWS transport. Only the
// browser's cookie jar and request headers and the network are faked. Fictional identifiers only.
const browser = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }>, headers: new Headers() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => browser.cookies.find((cookie) => cookie.name === name),
    getAll: (name?: string) => (name ? browser.cookies.filter((cookie) => cookie.name === name) : browser.cookies),
  }),
  headers: async () => browser.headers,
}));

import { NextRequest } from "next/server";
import { POST as labWorkspace } from "./labs/workspace/route";
import { POST as resolveTask } from "./tasks/resolve/route";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const HEADER = "x-alp-selected-organization-id";
const clinicA = randomUUID(), clinicB = randomUUID(), subA = randomUUID(), subB = randomUUID(), patient = randomUUID();
const idToken = (sub: string) => [{ alg: "RS256" }, { sub, token_use: "id" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional";
const binding = (sub: string) => createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex");
// The binding contract: a fingerprint of the account and the clinic, never either one in the clear.
const tabToken = (sub: string, organizationId: string) => "v1." + createHash("sha256")
  .update(`aidp-expected-clinic/1|${sub}|${organizationId}`).digest("base64url").slice(0, 32);

function session(sub: string, organizationCookies: Array<{ name: string; value: string }>) {
  browser.cookies = [
    { name: "aidp_at", value: idToken(sub) },
    { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: "fictional.practitioner@example.test" },
    ...organizationCookies,
  ];
}
const selected = (organizationId: string, sub: string) => [{ name: "aidp_org", value: organizationId }, { name: "aidp_org_sub", value: binding(sub) }];
/** One browser tab's request: it carries the binding its page was rendered under, or none on a tab's first call. */
const fromTab = (expected: string | null) => { browser.headers = new Headers(expected ? { "x-aidp-expected-clinic": expected } : {}); };
const workspace = () => labWorkspace(new NextRequest("https://desktop.example.test/api/live/labs/workspace", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId: patient }) }));
const resolve = () => resolveTask(new NextRequest("https://desktop.example.test/api/live/tasks/resolve", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: randomUUID() }) }));
let fetchMock: ReturnType<typeof vi.fn>;
let reply: (url: string, init: RequestInit) => Promise<Response>;
const upstreamClinics = () => (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([, init]) =>
  Object.entries((init.headers ?? {}) as Record<string, string>).filter(([key]) => key.toLowerCase() === HEADER).map(([, value]) => value).join());
const body = async (response: Response) => (await response.json()) as { data?: unknown; error?: { code: string; message: string } };

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
  reply = async (_url, init) => {
    const sent = String(init.body);
    const data = sent.includes("patient_profiles") ? [{ first_name: "Fictional", last_name: "Patient" }]
      : sent.includes("resolve_review_queue_item") ? { id: randomUUID(), status: "resolved", previous_status: "open", already_resolved: false } : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  fetchMock = vi.fn((url: string, init: RequestInit) => reply(url, init));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); browser.cookies = []; browser.headers = new Headers(); });

describe("the stale-tab clinic fence under database_current", () => {
  it("two tabs: after one switches the session's clinic, the other is refused as clinic changed before any request", async () => {
    session(subA, selected(clinicA, subA));
    fromTab(tabToken(subA, clinicA));
    const first = await workspace();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-aidp-clinic-binding")).toBe(tabToken(subA, clinicA));
    // Tab 2 switches the session to clinic B.
    session(subA, selected(clinicB, subA));
    fetchMock.mockClear();
    fromTab(tabToken(subA, clinicA));
    const stale = await workspace();
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toMatchObject({ code: "conflict", message: "Your clinic changed in another window. Reload to continue." });
    expect(fetchMock).not.toHaveBeenCalled();
    fromTab(tabToken(subA, clinicB));
    expect((await workspace()).status).toBe(200);
    expect(upstreamClinics().every((clinic) => clinic === clinicB)).toBe(true);
  });

  it("a tab's first call carries no binding and is told the current one", async () => {
    session(subA, selected(clinicB, subA));
    fromTab(null);
    const answered = await workspace();
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-aidp-clinic-binding")).toBe(tabToken(subA, clinicB));
  });

  it("a switch during an in-flight request: it finishes in the clinic it started in, and the tab's next call is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = reply;
    reply = async (url, init) => { await gate; return original(url, init); };
    session(subA, selected(clinicA, subA));
    fromTab(tabToken(subA, clinicA));
    const inFlight = workspace();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    session(subA, selected(clinicB, subA)); // another tab switches now
    release();
    const finished = await inFlight;
    expect(finished.status).toBe(200);
    expect(finished.headers.get("x-aidp-clinic-binding")).toBe(tabToken(subA, clinicA));
    expect(upstreamClinics().every((clinic) => clinic === clinicA)).toBe(true);
    fetchMock.mockClear();
    fromTab(tabToken(subA, clinicA));
    expect((await workspace()).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an account change: a tab rendered for another account is refused even when the clinic is the same", async () => {
    session(subB, selected(clinicA, subB));
    fromTab(tabToken(subA, clinicA));
    expect((await workspace()).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    fromTab(tabToken(subB, clinicA));
    expect((await workspace()).status).toBe(200);
  });

  it("an implicit-clinic write: an operation naming no clinic is refused from a stale tab, and runs from a current one", async () => {
    session(subA, selected(clinicB, subA));
    fromTab(tabToken(subA, clinicA));
    const stale = await resolve();
    expect(stale.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    fromTab(tabToken(subA, clinicB));
    const current = await resolve();
    expect(current.status).toBe(200);
    expect(upstreamClinics()).toEqual([clinicB]);
    expect(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).not.toContain(clinicB);
  });

  it("keeps the selection's own refusals for a missing, malformed, duplicate or other account's selection", async () => {
    const cases: Array<[Array<{ name: string; value: string }>, string]> = [
      [[], "clinic_selection_missing"],
      [[{ name: "aidp_org", value: "clinic-a" }, { name: "aidp_org_sub", value: binding(subA) }], "clinic_selection_malformed"],
      [[...selected(clinicA, subA), { name: "aidp_org", value: clinicB }], "clinic_selection_duplicate"],
      [selected(clinicA, subB), "clinic_selection_account_mismatch"],
    ];
    for (const [cookies] of cases) {
      session(subA, cookies);
      for (const expected of [null, tabToken(subA, clinicA), "v1.forged"]) {
        fromTab(expected);
        const refused = await workspace();
        expect(refused.status, JSON.stringify(cookies)).toBe(400);
        expect(refused.headers.get("x-aidp-clinic-binding")).toBeNull();
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses two expected bindings rather than choosing one", async () => {
    session(subA, selected(clinicA, subA));
    browser.headers = new Headers();
    browser.headers.append("x-aidp-expected-clinic", tabToken(subA, clinicA));
    browser.headers.append("x-aidp-expected-clinic", tabToken(subA, clinicA));
    expect((await workspace()).status).toBe(409);
  });
});

describe("the legacy default", () => {
  it("ignores an expected binding and names none", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "");
    session(subA, [{ name: "aidp_org", value: clinicA }]);
    fromTab("v1.anything");
    const answered = await workspace();
    expect(answered.status).toBe(200);
    expect(answered.headers.get("x-aidp-clinic-binding")).toBeNull();
  });
});
