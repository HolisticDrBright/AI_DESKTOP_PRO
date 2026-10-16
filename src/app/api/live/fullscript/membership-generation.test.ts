import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A saved Fullscript connection is bound to the membership generation it was installed under. These run the real route
// handlers, session reader, clinic list and runtime under the deployed default (`legacy_claims`). Faked at their
// boundary: the cookie jar, the network, Fullscript's own HTTP client, the token table (a keyed table), the two fence
// reads (the current generation) and the revocation outbox. Fictional identifiers and tokens only. No token is printed.
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
  changing: false, supersede: vi.fn() }));
vi.mock("@/server/fullscript/membership-generation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/fullscript/membership-generation")>();
  return { ...original,
    createAwsFullscriptGenerationReader: () => ({ current: async () => {
      if (generation.changing) throw new (await import("@/server/fullscript/client")).FullscriptUnavailableError();
      return generation.value;
    } }),
    createAwsFullscriptRevocationOutbox: () => ({ supersede: generation.supersede, pending: vi.fn(async () => []), settle: vi.fn() }) };
});
vi.mock("@/server/fullscript/connection-admission", () => ({
  createAwsFullscriptConnectionAdmission: () => ({ observe: vi.fn(), install: vi.fn() }),
}));
const provider = vi.hoisted(() => ({ constructed: vi.fn(), searchProducts: vi.fn(), labCheckout: vi.fn(), revoke: vi.fn(), refresh: vi.fn() }));
vi.mock("@/server/fullscript/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/fullscript/client")>();
  class FictionalFullscriptApiClient {
    constructor(...args: unknown[]) { provider.constructed(...args); }
    searchProducts(query: string) { return provider.searchProducts(query); }
    createLabTreatmentPlan(input: unknown) { return provider.labCheckout(input); }
  }
  return { ...original, FullscriptApiClient: FictionalFullscriptApiClient, revokeFullscriptToken: provider.revoke, refreshFullscriptToken: provider.refresh };
});

import { GET as status } from "./status/route";
import { POST as action } from "./action/route";
import { fullscriptActor } from "@/server/fullscript/runtime";
import type { RequestSession } from "@/server/session";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const EMAIL = "fictional.practitioner@example.test";
const clinic = randomUUID(), sub = randomUUID();
const idToken = [{ alg: "RS256", kid: "fictional" }, { sub, email: EMAIL, token_use: "id", email_verified: true }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const session: RequestSession = { signedIn: true, email: EMAIL, orgId: clinic, token: idToken, expired: false, expiresAt: null };
const ADMITTED = { protocol: "fullscript-generation/1" as const, subjectFence: 3, clinicFence: 5 };
/** A saved connection; `null` is one saved before generations existed. */
const saved = (membershipGeneration: unknown = ADMITTED) => ({ ...fullscriptActor(session), environment: "sandbox_us",
  accessToken: "fictional-access-token-abcdefghijklmnopqrstuvwxyz", refreshToken: "fictional-refresh-token-abcdefghijklmnopqrstuvwxyz",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" }, scope: ["catalog:read"],
  ...(membershipGeneration === null ? {} : { membershipGeneration }) });
let member = true;
const json = async (response: Response) => (await response.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown) => new Request("https://desktop.example.test/api/live/fullscript/action", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const search = () => action(post({ action: "search_products", query: "fictional magnesium" }));

beforeEach(() => {
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  vi.stubEnv("FULLSCRIPT_ENVIRONMENT", "sandbox_us");
  vi.stubEnv("FULLSCRIPT_CLIENT_ID", "fictional-client-id-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_CLIENT_SECRET", "fictional-client-secret-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_REDIRECT_URI", "https://fictional.example.test/api/live/fullscript/oauth/callback");
  vi.stubEnv("FULLSCRIPT_OAUTH_STATE_SECRET", "fictional-state-secret-longer-than-32-characters");
  member = true;
  generation.value = { ...ADMITTED };
  generation.changing = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: member
    ? [{ organization_id: clinic, name: "Fictional", slug: "f", role: "practitioner" }] : [] }), { status: 200 })));
  rows.clear();
  for (const spy of [...Object.values(store), ...Object.values(provider), generation.supersede]) spy.mockReset();
  rows.set("row", saved());
  store.get.mockImplementation(async () => rows.get("row") ?? null);
  store.replace.mockImplementation(async (_previous: unknown, replacement: Record<string, unknown>) => {
    if (!rows.has("row")) return false;
    rows.set("row", replacement);
    return true;
  });
  // The outbox moves the row out of the token table, as its TransactWrite does.
  generation.supersede.mockImplementation(async () => (rows.delete("row") ? "moved" : "already_gone"));
  provider.searchProducts.mockResolvedValue({ products: [{ id: "fictional-product" }] });
  provider.labCheckout.mockResolvedValue({ checkout_url: "https://us-snd.fullscript.io/fictional-checkout" });
  jar.cookies = [{ name: "aidp_at", value: idToken }, { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: EMAIL }, { name: "aidp_org", value: clinic }];
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); jar.cookies = []; });

describe("a removed member's Fullscript connection cannot silently reappear when they are re-added", () => {
  it("control: a connection made under the current generation is used", async () => {
    expect((await search()).status).toBe(200);
    expect((await json(await status())).data).toMatchObject({ connected: true });
  });

  it("removed, then re-added: the old connection is not used again; it moves to the revocation outbox and reconnect is asked", async () => {
    member = false;
    expect((await search()).status).toBe(403);
    // The removal began and settled the subject's fence (two moves); then the member is re-added.
    generation.value = { ...ADMITTED, subjectFence: ADMITTED.subjectFence + 2 };
    member = true;
    // The route answers Fullscript's unavailable errors as it always has (not 200); the status read says why.
    expect((await search()).status).not.toBe(200);
    expect(provider.searchProducts).not.toHaveBeenCalled();
    expect(provider.constructed).not.toHaveBeenCalled();
    expect(generation.supersede).toHaveBeenCalledWith(expect.objectContaining({ actorKey: fullscriptActor(session).actorKey }), "membership_changed");
    expect(rows.has("row")).toBe(false);
    expect((await json(await status())).data).toMatchObject({ connected: false });
  });

  it("the status read names it: reconnect required, not connected, and the provider is never asked", async () => {
    generation.value = { ...ADMITTED, subjectFence: ADMITTED.subjectFence + 2 };
    expect((await json(await status())).data).toMatchObject({ configured: true, connected: false, reconnectRequired: true });
    expect(provider.constructed).not.toHaveBeenCalled();
    expect(generation.supersede).toHaveBeenCalledOnce();
  });

  it("failing before: removed, then re-added, with a connection saved as every connection is today (no generation)", async () => {
    member = false;
    expect((await search()).status).toBe(403);
    generation.value = { ...ADMITTED, subjectFence: ADMITTED.subjectFence + 2 };
    member = true;
    rows.set("row", saved(null));
    // Before generations, nothing distinguished this connection from one made after the re-add: it was used again.
    expect((await search()).status).not.toBe(200);
    expect(provider.searchProducts).not.toHaveBeenCalled();
  });

  it("a clinic suspended and reinstated, or an identity disabled and recovered, is the same: the clinic fence or the subject fence moved", async () => {
    generation.value = { ...ADMITTED, clinicFence: ADMITTED.clinicFence + 2 };
    expect((await search()).status).not.toBe(200);
    expect(generation.supersede).toHaveBeenCalledOnce();
  });

  it("a connection saved before generations existed is treated as superseded (fail closed)", async () => {
    rows.set("row", saved(null));
    const posture = (await json(await status())).data;
    expect(posture).toMatchObject({ connected: false, reconnectRequired: true });
    expect(generation.supersede).toHaveBeenCalledWith(expect.anything(), "membership_changed");
  });

  it("while a membership change is in flight nothing is used and nothing is moved", async () => {
    generation.changing = true;
    expect((await search()).status).not.toBe(200);
    expect(generation.supersede).not.toHaveBeenCalled();
    expect(rows.has("row")).toBe(true);
  });

  it("a refresh never carries a superseded connection forward, and never rewrites its generation", async () => {
    rows.set("row", { ...saved(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
    generation.value = { ...ADMITTED, subjectFence: ADMITTED.subjectFence + 2 };
    expect((await search()).status).not.toBe(200);
    expect(provider.refresh).not.toHaveBeenCalled();
    // Current generation: the refresh keeps the recorded generation exactly.
    rows.set("row", { ...saved(), expiresAt: new Date(Date.now() + 30_000).toISOString() });
    generation.value = { ...ADMITTED };
    provider.refresh.mockResolvedValue({ accessToken: "fictional-rotated-access-token-abcdefghij", refreshToken: "fictional-rotated-refresh-token-abcdefghij",
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(), resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" }, scope: ["catalog:read"] });
    expect((await search()).status).toBe(200);
    expect(rows.get("row")).toMatchObject({ membershipGeneration: ADMITTED, accessToken: "fictional-rotated-access-token-abcdefghij" });
  });

  it("lab checkout stays held even with the ordering and production flags forced on, before any token is used", async () => {
    vi.stubEnv("FULLSCRIPT_LAB_ORDERING_ENABLED", "true");
    vi.stubEnv("FULLSCRIPT_PRODUCTION_APPROVED", "true");
    const response = await action(post({ action: "create_lab_checkout", fullscriptPatientId: "fictional-patient-id", labTestId: "fictional-lab-test",
      payerType: "patient" }));
    expect(response.status).toBe(403);
    expect(provider.labCheckout).not.toHaveBeenCalled();
    expect(provider.constructed).not.toHaveBeenCalled();
  });
});
