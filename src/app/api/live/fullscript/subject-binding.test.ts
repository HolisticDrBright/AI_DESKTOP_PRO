import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A saved Fullscript connection belongs to one workforce subject, not to an email address, and an action whose result
// reaches the practitioner is withheld if the practitioner's clinic authority changes while Fullscript is answering.
// These run the real route handlers, session reader, clinic list and clinical transport under the deployed default
// (`legacy_claims`). Faked: the cookie jar, the network, Fullscript's own HTTP client, and a token table modelled
// faithfully as a keyed table, one row per (clinic, key). Fictional identifiers and tokens only. No token is printed.
const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
    getAll: (name?: string) => (name ? jar.cookies.filter((cookie) => cookie.name === name) : jar.cookies),
  }),
  headers: async () => new Headers(),
}));
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const store = vi.hoisted(() => ({ get: vi.fn(), replace: vi.fn(), delete: vi.fn(), consumeNonce: vi.fn() }));
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
vi.mock("@/server/fullscript/connection-admission", () => ({
  createAwsFullscriptConnectionAdmission: () => ({ observe: vi.fn(), install: vi.fn() }),
}));
const provider = vi.hoisted(() => ({ constructed: vi.fn(), searchProducts: vi.fn(), treatmentPlanLink: vi.fn(), labCheckout: vi.fn(),
  revoke: vi.fn(), refresh: vi.fn() }));
vi.mock("@/server/fullscript/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/fullscript/client")>();
  class FictionalFullscriptApiClient {
    constructor(...args: unknown[]) { provider.constructed(...args); }
    searchProducts(query: string) { return provider.searchProducts(query); }
    retrieveNewTreatmentPlanLink() { return provider.treatmentPlanLink(); }
    createLabTreatmentPlan(input: unknown) { return provider.labCheckout(input); }
  }
  return { ...original, FullscriptApiClient: FictionalFullscriptApiClient,
    revokeFullscriptToken: provider.revoke, refreshFullscriptToken: provider.refresh };
});

import { GET as status } from "./status/route";
import { POST as action } from "./action/route";
import { POST as disconnect } from "./disconnect/route";
import { fullscriptActor } from "@/server/fullscript/runtime";
import type { RequestSession } from "@/server/session";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
// Two distinct workforce accounts (Cognito subjects) carrying the same verified address, both current members of the
// same fictional clinic: a re-created account, an alias, or a second sign-in method for the same mailbox.
const EMAIL = "fictional.shared@example.test";
const clinic = randomUUID(), subA = randomUUID(), subB = randomUUID();
const idToken = (sub: string) => [{ alg: "RS256", kid: "fictional" }, { sub, email: EMAIL, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const sessionFor = (sub: string): RequestSession => ({ signedIn: true, email: EMAIL, orgId: clinic, token: idToken(sub), expired: false, expiresAt: null });
/** The key every connection carried before this change: clinic and lower-case email, nothing about the account. */
const emailKey = createHash("sha256").update(`${clinic}\u0000${EMAIL.toLowerCase()}`).digest("hex");
const ACCESS_A = "fictional-access-token-of-subject-a-abcdefghij";
const connection = (actorKey: string, accessToken = ACCESS_A, expiresIn = 3_600_000) => ({ actorKey, organizationId: clinic,
  environment: "sandbox_us", accessToken, refreshToken: "fictional-refresh-token-abcdefghijklmnopqrstuvwxyz",
  expiresAt: new Date(Date.now() + expiresIn).toISOString(), connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  resourceOwner: { id: "fictional-practitioner-a-id", type: "Practitioner" }, scope: ["catalog:read"], membershipGeneration: generation.value });
const rowKey = (organizationId: string, actorKey: string) => `${organizationId}|${actorKey}`;
const saveFor = (actorKey: string, value = connection(actorKey)) => rows.set(rowKey(clinic, actorKey), value);

let current: Record<string, string[]>;
const subjectOf = (init: RequestInit) => {
  const bearer = String(((init.headers ?? {}) as Record<string, string>).Authorization ?? "").replace(/^Bearer /, "");
  return JSON.parse(Buffer.from(bearer.split(".")[1]!, "base64url").toString("utf8")).sub as string;
};
function signIn(sub: string) {
  jar.cookies = [{ name: "aidp_at", value: idToken(sub) }, { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: EMAIL }, { name: "aidp_org", value: clinic }];
}
const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown) => new Request("https://desktop.example.test/api/live/fullscript/action", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const search = () => action(post({ action: "search_products", query: "fictional magnesium" }));
const usedTokens = () => provider.constructed.mock.calls.map((call) => call[1]);
const removeFromClinic = (sub: string) => { current[sub] = []; };

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("FULLSCRIPT_ENVIRONMENT", "sandbox_us");
  vi.stubEnv("FULLSCRIPT_CLIENT_ID", "fictional-client-id-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_CLIENT_SECRET", "fictional-client-secret-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_REDIRECT_URI", "https://fictional.example.test/api/live/fullscript/oauth/callback");
  vi.stubEnv("FULLSCRIPT_OAUTH_STATE_SECRET", "fictional-state-secret-longer-than-32-characters");
  current = { [subA]: [clinic], [subB]: [clinic] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const clinics = current[subjectOf(init)] ?? [];
    return new Response(JSON.stringify({ data: clinics.map((organization_id) => ({ organization_id, name: "Fictional", slug: "f", role: "practitioner" })) }),
      { status: 200 });
  }));
  rows.clear();
  for (const spy of [...Object.values(store), ...Object.values(provider)]) spy.mockReset();
  store.get.mockImplementation(async (actorKey: string, organizationId: string) => rows.get(rowKey(organizationId, actorKey)) ?? null);
  store.delete.mockImplementation(async (previous: { actorKey: string; organizationId: string }) => rows.delete(rowKey(previous.organizationId, previous.actorKey)));
  store.replace.mockImplementation(async (previous: { actorKey: string; organizationId: string }, replacement: Record<string, unknown>) => {
    if (!rows.has(rowKey(previous.organizationId, previous.actorKey))) return false;
    rows.set(rowKey(previous.organizationId, previous.actorKey), replacement);
    return true;
  });
  provider.searchProducts.mockResolvedValue({ products: [{ id: "fictional-product" }] });
  provider.treatmentPlanLink.mockResolvedValue({ redirect_url: "https://us-snd.fullscript.io/fictional-plan" });
  provider.labCheckout.mockResolvedValue({ checkout_url: "https://us-snd.fullscript.io/fictional-checkout" });
  provider.revoke.mockResolvedValue(undefined);
  provider.refresh.mockResolvedValue({ accessToken: "fictional-rotated-access-token-abcdefghij", refreshToken: "fictional-rotated-refresh-token-abcdefghij",
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(), resourceOwner: { id: "fictional-practitioner-a-id", type: "Practitioner" }, scope: ["catalog:read"] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar.cookies = []; });

describe("a saved connection belongs to the account that made it, not to its email address", () => {
  it("the two accounts derive different keys", () => {
    expect(fullscriptActor(sessionFor(subA)).actorKey).not.toBe(fullscriptActor(sessionFor(subB)).actorKey);
  });

  it("control: the account that connected reaches its own connection", async () => {
    saveFor(fullscriptActor(sessionFor(subA)).actorKey);
    signIn(subA);
    expect((await json(await status())).data).toMatchObject({ connected: true });
    expect((await search()).status).toBe(200);
    expect(usedTokens()).toEqual([ACCESS_A]);
  });

  it("another account with the same address in the same clinic sees no connection, cannot use it and cannot revoke it", async () => {
    saveFor(fullscriptActor(sessionFor(subA)).actorKey);
    signIn(subB);
    expect((await json(await status())).data).toMatchObject({ connected: false });
    expect((await search()).status).not.toBe(200);
    expect(provider.constructed).not.toHaveBeenCalled();
    await disconnect();
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
  });
});

describe("a connection saved under the older email key is never claimed silently", () => {
  it.each([["the account that made it", subA], ["another account with the same address", subB]])(
    "%s is told to reconnect; the old row is not used, refreshed, revoked or deleted", async (_who, sub) => {
      rows.set(rowKey(clinic, emailKey), connection(emailKey, ACCESS_A, 0));
      signIn(sub);
      expect((await json(await status())).data).toMatchObject({ configured: true, connected: false, reconnectRequired: true });
      expect((await search()).status).not.toBe(200);
      await disconnect();
      expect(provider.constructed).not.toHaveBeenCalled();
      expect(provider.refresh).not.toHaveBeenCalled();
      expect(provider.revoke).not.toHaveBeenCalled();
      expect([...rows.keys()]).toEqual([rowKey(clinic, emailKey)]);
    });
});

describe("clinic authority changing before admission and while Fullscript is answering", () => {
  beforeEach(() => { saveFor(fullscriptActor(sessionFor(subA)).actorKey); signIn(subA); });

  it.each(["removed", "suspended"])("membership %s before admission: refused before the connection is read (coverage)", async () => {
    removeFromClinic(subA); // list_my_organizations omits both a removed membership and a suspended clinic
    expect((await search()).status).toBe(403);
    expect(store.get).not.toHaveBeenCalled();
    expect(provider.constructed).not.toHaveBeenCalled();
  });

  it.each(["removed", "suspended"])("membership %s while the product search is in flight: the result is withheld", async () => {
    provider.searchProducts.mockImplementation(async () => { removeFromClinic(subA); return { products: [{ id: "fictional-product" }] }; });
    const response = await search();
    expect(response.status).toBe(403);
    expect(JSON.stringify(await json(response))).not.toContain("fictional-product");
  });

  it("membership removed while a treatment-plan link is being issued: the link is withheld", async () => {
    provider.treatmentPlanLink.mockImplementation(async () => { removeFromClinic(subA); return { redirect_url: "https://us-snd.fullscript.io/fictional-plan" }; });
    const response = await action(post({ action: "new_treatment_plan_link" }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await json(response))).not.toContain("fictional-plan");
  });

  it("membership removed during a token refresh: the rotated token replaces the old one only by its conditional write, and the result is withheld", async () => {
    saveFor(fullscriptActor(sessionFor(subA)).actorKey, connection(fullscriptActor(sessionFor(subA)).actorKey, ACCESS_A, 0));
    provider.refresh.mockImplementation(async () => {
      removeFromClinic(subA);
      return { accessToken: "fictional-rotated-access-token-abcdefghij", refreshToken: "fictional-rotated-refresh-token-abcdefghij",
        expiresAt: new Date(Date.now() + 7_200_000).toISOString(), resourceOwner: { id: "fictional-practitioner-a-id", type: "Practitioner" }, scope: ["catalog:read"] };
    });
    expect((await search()).status).toBe(403);
    expect(store.replace).toHaveBeenCalledTimes(1);
  });

  it("membership removed during a disconnect: the provider revocation and the row deletion still complete (coverage)", async () => {
    provider.revoke.mockImplementation(async () => { removeFromClinic(subA); });
    expect((await disconnect()).status).toBe(200);
    expect(provider.revoke).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
  });
});

describe("an action whose provider commit cannot be fenced or compensated is held", () => {
  it("lab checkout is refused before any token use, even with lab ordering switched on", async () => {
    saveFor(fullscriptActor(sessionFor(subA)).actorKey);
    signIn(subA);
    vi.stubEnv("FULLSCRIPT_LAB_ORDERING_ENABLED", "true");
    const response = await action(post({ action: "create_lab_checkout", fullscriptPatientId: "fictional-patient-id", labTestId: "fictional-lab-test",
      idempotencyKey: randomUUID() }));
    expect(response.status).not.toBe(200);
    expect(provider.labCheckout).not.toHaveBeenCalled();
    expect(provider.constructed).not.toHaveBeenCalled();
    expect(provider.refresh).not.toHaveBeenCalled();
  });
});
