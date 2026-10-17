import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Fullscript routes under both workforce authorities: the real route handlers, session reader, clinic list and
// clinical transport, with only the cookie jar, the network, the token table and Fullscript's own HTTP client faked.
// Fictional identifiers only.
const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
    getAll: (name?: string) => (name ? jar.cookies.filter((cookie) => cookie.name === name) : jar.cookies),
  }),
  headers: async () => new Headers(),
}));
const store = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), replace: vi.fn(), delete: vi.fn(), consumeNonce: vi.fn() }));
vi.mock("@/server/fullscript/token-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/fullscript/token-store")>()),
  createAwsFullscriptTokenStore: () => store,
}));
const generation = vi.hoisted(() => ({ value: { protocol: "fullscript-generation/1" as const, subjectFence: 3, clinicFence: 5 },
  supersede: vi.fn(async () => "moved" as const) }));
vi.mock("@/server/fullscript/membership-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/fullscript/membership-generation")>()),
  // The fence read and the outbox, faked at their boundary: the current generation, and a recorded supersede.
  createAwsFullscriptGenerationReader: () => ({ current: async () => generation.value }),
  createAwsFullscriptRevocationOutbox: () => ({ supersede: generation.supersede, pending: vi.fn(async () => []), settle: vi.fn() }),
}));
const admissionStore = vi.hoisted(() => ({ observe: vi.fn(), install: vi.fn() }));
vi.mock("@/server/fullscript/connection-admission", () => ({
  createAwsFullscriptConnectionAdmission: () => admissionStore,
}));
const provider = vi.hoisted(() => ({ constructed: vi.fn(), searchProducts: vi.fn(), revoke: vi.fn(), exchange: vi.fn() }));
vi.mock("@/server/fullscript/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/fullscript/client")>();
  class FictionalFullscriptApiClient {
    constructor(...args: unknown[]) { provider.constructed(...args); }
    searchProducts(query: string) { return provider.searchProducts(query); }
  }
  return { ...original, FullscriptApiClient: FictionalFullscriptApiClient,
    revokeFullscriptToken: provider.revoke, exchangeFullscriptAuthorizationCode: provider.exchange };
});

import { NextRequest } from "next/server";
import { GET as status } from "./status/route";
import { POST as action } from "./action/route";
import { POST as disconnect } from "./disconnect/route";
import { POST as start } from "./oauth/start/route";
import { GET as callback } from "./oauth/callback/route";
import { createFullscriptAuthorization, readFullscriptConfiguration } from "@/server/fullscript/client";
import { fullscriptActor } from "@/server/fullscript/runtime";
import { FULLSCRIPT_CLINIC_REFUSED, FULLSCRIPT_CLINIC_UNVERIFIED } from "@/server/fullscript/clinic-authority";
import type { RequestSession } from "@/server/session";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const DISCOVERY = `${ORIGIN}/clinical-core/workforce/memberships/current`;
const EMAIL = "fictional.practitioner@example.test", OTHER_EMAIL = "fictional.colleague@example.test";
const clinicA = randomUUID(), clinicB = randomUUID(), subA = randomUUID(), subB = randomUUID();
const idToken = (sub: string, email = EMAIL) => [{ alg: "RS256", kid: "fictional" }, { sub, email, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const binding = (sub: string) => createHash("sha256").update(`aidp-selected-clinic/1|${sub}`).digest("hex");

/** The clinics each fictional subject currently has, as the clinical service would answer now; a number is an outage. */
let current: Record<string, string[] | number>;
let fetchMock: ReturnType<typeof vi.fn>;
const subjectOf = (init: RequestInit) => {
  const bearer = String(((init.headers ?? {}) as Record<string, string>).Authorization ?? "").replace(/^Bearer /, "");
  return JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")).sub as string;
};
const clinicReads = () => (fetchMock.mock.calls as Array<[string, RequestInit]>)
  .filter(([url, init]) => url === DISCOVERY || String(init.body ?? "").includes("list_my_organizations"));

function signedIn(sub: string, clinic: string | null, opts: { expired?: boolean; boundTo?: string; email?: string; cookieEmail?: string } = {}) {
  jar.cookies = [
    { name: "aidp_at", value: idToken(sub, opts.email ?? EMAIL) },
    { name: "aidp_exp", value: String(Date.now() + (opts.expired ? -60_000 : 3_600_000)) },
    { name: "aidp_em", value: opts.cookieEmail ?? opts.email ?? EMAIL },
    ...(clinic ? [{ name: "aidp_org", value: clinic }, { name: "aidp_org_sub", value: binding(opts.boundTo ?? sub) }] : []),
  ];
}
const sessionFor = (sub: string, clinic: string): RequestSession => ({ signedIn: true, email: EMAIL, orgId: clinic,
  token: idToken(sub), expired: false, expiresAt: null });
const saved = (clinic: string) => ({ ...fullscriptActor(sessionFor(subA, clinic)), environment: "sandbox_us",
  accessToken: "fictional-access-token-abcdefghijklmnopqrstuvwxyz", refreshToken: "fictional-refresh-token-abcdefghijklmnopqrstuvwxyz",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" }, scope: ["catalog:read"], membershipGeneration: generation.value });
const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown) => new Request("https://desktop.example.test/api/live/fullscript/action", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Every Fullscript operation a signed-in practitioner can reach from the Desktop. */
const operations = {
  status: () => status(),
  search: () => action(post({ action: "search_products", query: "fictional magnesium" })),
  disconnect: () => disconnect(),
  start: () => start(),
} as const;
const untouched = () => {
  expect(store.get).not.toHaveBeenCalled();
  expect(store.delete).not.toHaveBeenCalled();
  expect(provider.constructed).not.toHaveBeenCalled();
  expect(provider.revoke).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("FULLSCRIPT_ENVIRONMENT", "sandbox_us");
  vi.stubEnv("FULLSCRIPT_CLIENT_ID", "fictional-client-id-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_CLIENT_SECRET", "fictional-client-secret-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_REDIRECT_URI", "https://fictional.example.test/api/live/fullscript/oauth/callback");
  vi.stubEnv("FULLSCRIPT_OAUTH_STATE_SECRET", "fictional-state-secret-longer-than-32-characters");
  current = {};
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const answer = current[subjectOf(init)];
    if (typeof answer === "number") return new Response(JSON.stringify({ error: "database_unavailable" }), { status: answer });
    const clinics = answer ?? [];
    if (url === DISCOVERY) {
      return new Response(JSON.stringify({ data: { clinics: clinics.map((organizationId) => ({ organizationId, name: "Fictional", role: "practitioner" })),
        pending: [] } }), { status: 200 });
    }
    if (String(init.body ?? "").includes("list_my_organizations")) {
      return new Response(JSON.stringify({ data: clinics.map((organization_id) => ({ organization_id, name: "Fictional", slug: "f", role: "practitioner" })) }),
        { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  for (const spy of [...Object.values(store), ...Object.values(provider)]) spy.mockReset();
  for (const spy of Object.values(admissionStore)) spy.mockReset();
  admissionStore.observe.mockResolvedValue({ fictionalAdmission: true });
  admissionStore.install.mockImplementation(async () => {
    if (!Array.isArray(current[subA]) || !current[subA].includes(clinicA)) throw new Error("membership_changed");
  });
  store.get.mockImplementation(async (_actor: string, clinic: string) => saved(clinic));
  store.delete.mockResolvedValue(true);
  store.consumeNonce.mockResolvedValue(true);
  provider.searchProducts.mockResolvedValue({ products: [] });
  provider.revoke.mockResolvedValue(undefined);
  provider.exchange.mockResolvedValue({ accessToken: "fictional-new-access-token-abcdefghijklmnopqrstuvwxyz",
    refreshToken: "fictional-new-refresh-token-abcdefghijklmnopqrstuvwxyz", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" }, scope: ["catalog:read"] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar.cookies = []; });

describe.each(["legacy_claims", "database_current"] as const)("Fullscript under %s: the session's clinic is re-read, never trusted", (mode) => {
  beforeEach(() => { if (mode === "database_current") vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current"); });

  it("a current member reaches each Fullscript operation, after the clinic is re-read", async () => {
    current[subA] = [clinicA];
    signedIn(subA, clinicA);
    for (const [name, run] of Object.entries(operations)) {
      const response = await run();
      expect(response.status, name).toBe(200);
    }
    expect((await json(await operations.status())).data).toMatchObject({ configured: true, connected: true });
    expect(provider.searchProducts).toHaveBeenCalledWith("fictional magnesium");
    expect(provider.revoke).toHaveBeenCalledOnce();
    expect(clinicReads().length).toBeGreaterThanOrEqual(Object.keys(operations).length);
  });

  it("a removed membership or a suspended clinic, absent from the account's clinics, is refused before the connection is read", async () => {
    for (const now of [[], [clinicB]]) {
      current[subA] = now;
      signedIn(subA, clinicA);
      for (const [name, run] of Object.entries(operations)) {
        const response = await run();
        expect(response.status, name).toBe(403);
        expect((await json(response)).error, name).toEqual({ code: "forbidden", message: FULLSCRIPT_CLINIC_REFUSED });
      }
    }
    untouched();
  });

  it("a clinic read that fails refuses as unavailable and never falls back to the cookie", async () => {
    current[subA] = 503;
    signedIn(subA, clinicA);
    for (const [name, run] of Object.entries(operations)) {
      const response = await run();
      expect(response.status, name).toBe(503);
      expect((await json(response)).error, name).toEqual({ code: "unavailable", message: FULLSCRIPT_CLINIC_UNVERIFIED });
    }
    untouched();
  });

  it("an account with no clinic (an unapproved sign-up) or an expired session is refused before any read", async () => {
    current[subA] = [clinicA];
    for (const [setup, code] of [[() => signedIn(subA, null), 403], [() => signedIn(subA, clinicA, { expired: true }), 401]] as const) {
      setup();
      for (const [name, run] of Object.entries(operations)) expect((await run()).status, name).toBe(code);
    }
    expect(clinicReads()).toEqual([]);
    untouched();
  });
});

describe.each(["legacy_claims", "database_current"] as const)("Fullscript under %s: the practitioner is the token's, not the cookie's", (mode) => {
  it("a member who edits the display email cookie to a colleague's is refused before any connection is read", async () => {
    if (mode === "database_current") vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
    current[subA] = [clinicA];
    for (const cookieEmail of [OTHER_EMAIL, "FICTIONAL.COLLEAGUE@example.test", ""]) {
      signedIn(subA, clinicA, { cookieEmail });
      for (const [name, run] of Object.entries(operations)) {
        const response = await run();
        expect(response.status, `${name} ${cookieEmail}`).toBe(403);
        expect((await json(response)).error, name).toEqual({ code: "forbidden", message: FULLSCRIPT_CLINIC_REFUSED });
      }
    }
    untouched();
  });

  it("the same email in another letter case is the same practitioner", async () => {
    if (mode === "database_current") vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
    current[subA] = [clinicA];
    signedIn(subA, clinicA, { cookieEmail: EMAIL.toUpperCase() });
    expect((await json(await operations.status())).data).toMatchObject({ configured: true, connected: true });
    expect(store.get).toHaveBeenCalledWith(fullscriptActor(sessionFor(subA, clinicA)).actorKey, clinicA);
  });
});

describe("Fullscript under database_current: the selection must be this account's own", () => {
  it("a clinic chosen by another account in the same browser is refused before any read", async () => {
    vi.stubEnv("CLINICAL_WORKFORCE_AUTHORITY_MODE", "database_current");
    current[subA] = [clinicA];
    signedIn(subA, clinicA, { boundTo: subB });
    for (const [name, run] of Object.entries(operations)) {
      const response = await run();
      expect(response.status, name).toBe(403);
      expect((await json(response)).error, name).toEqual({ code: "forbidden", message: FULLSCRIPT_CLINIC_REFUSED });
    }
    expect(clinicReads()).toEqual([]);
    untouched();
  });
});

describe("the Fullscript authorization callback completes only for the account and clinic that started it", () => {
  const returned = (state: string) => {
    const url = new URL("https://fictional.example.test/api/live/fullscript/oauth/callback");
    url.searchParams.set("state", state);
    url.searchParams.set("code", "fictional-authorization-code-abcdefghijklmnopqrstuvwxyz");
    return new NextRequest(url);
  };
  const startedBy = (sub: string, clinic: string) => createFullscriptAuthorization({ configuration: readFullscriptConfiguration(),
    ...fullscriptActor(sessionFor(sub, clinic)), subject: sub, nonce: randomUUID().replaceAll("-", "") }).state;
  const outcome = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("fullscript");

  it("in the browser of the account that started it, still a member, the installation is saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    current[subA] = [clinicA];
    signedIn(subA, clinicA);
    const response = await callback(returned(startedBy(subA, clinicA)));
    expect(outcome(response)).toBe("connected");
    expect(admissionStore.install).toHaveBeenCalledOnce();
    expect(admissionStore.install.mock.calls[0]![0]).toMatchObject(fullscriptActor(sessionFor(subA, clinicA)));
    expect(store.put).not.toHaveBeenCalled();
  });

  it("in another account's browser, after the membership is removed, with an edited email cookie or with no session, nothing is exchanged or saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: Array<[string, () => void]> = [
      ["another signed-in account", () => { current[subB] = [clinicA]; signedIn(subB, clinicA, { email: OTHER_EMAIL }); }],
      ["the same account in another clinic", () => { current[subA] = [clinicA, clinicB]; signedIn(subA, clinicB); }],
      ["another account claiming the starter's email in its cookie", () => { current[subB] = [clinicA]; signedIn(subB, clinicA, { email: OTHER_EMAIL, cookieEmail: EMAIL }); }],
      ["membership removed since it started", () => { current[subA] = []; signedIn(subA, clinicA); }],
      ["no session", () => { jar.cookies = []; }],
    ];
    for (const [name, setup] of cases) {
      setup();
      expect(outcome(await callback(returned(startedBy(subA, clinicA)))), name).toBe("session_changed");
    }
    expect(store.consumeNonce).not.toHaveBeenCalled();
    expect(provider.exchange).not.toHaveBeenCalled();
    expect(admissionStore.install).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not install a provider token when membership is revoked during code exchange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    current[subA] = [clinicA];
    signedIn(subA, clinicA);
    const state = startedBy(subA, clinicA);
    provider.exchange.mockImplementation(async () => {
      // The initial clinic read succeeded. The clinic removes this member while
      // the external provider is answering, before the token-store write.
      current[subA] = [];
      return {
        accessToken: "fictional-new-access-token-abcdefghijklmnopqrstuvwxyz",
        refreshToken: "fictional-new-refresh-token-abcdefghijklmnopqrstuvwxyz",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" },
        scope: ["catalog:read"],
      };
    });

    expect(outcome(await callback(returned(state)))).toBe("session_changed");
    expect(admissionStore.install).toHaveBeenCalledOnce();
    expect(provider.revoke).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("refuses another account with the same address and clinic as the OAuth starter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    current[subA] = [clinicA];
    const state = startedBy(subA, clinicA);
    current[subB] = [clinicA];
    signedIn(subB, clinicA); // Same email claim and clinic, but a different Cognito subject.
    expect(outcome(await callback(returned(state)))).toBe("session_changed");
    expect(provider.exchange).not.toHaveBeenCalled();
    expect(admissionStore.install).not.toHaveBeenCalled();
  });
});
