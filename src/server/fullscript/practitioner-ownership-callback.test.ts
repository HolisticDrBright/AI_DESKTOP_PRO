import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The OAuth callback, end to end over fictional tables: the real admission, outbox and token store, with Fullscript
// and the workforce API at their HTTP boundary. A Fullscript practitioner connected to one Desktop account is refused
// for a second one, the second account's freshly issued token is queued BEFORE it is revoked, and the first account's
// connection is byte-identical afterwards. Fictional accounts, clinics, practitioners and tokens only.
const jar = vi.hoisted(() => ({ cookies: [] as Array<{ name: string; value: string }> }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => jar.cookies.find((cookie) => cookie.name === name),
  getAll: (name?: string) => (name ? jar.cookies.filter((cookie) => cookie.name === name) : jar.cookies) }), headers: async () => new Headers() }));
const tables = vi.hoisted(() => ({ send: null as null | ((command: unknown) => Promise<unknown>) }));
vi.mock("@/server/fullscript/connection-admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connection-admission")>();
  return { ...actual, createAwsFullscriptConnectionAdmission: (env?: NodeJS.ProcessEnv) => actual.createAwsFullscriptConnectionAdmission(env, (c) => tables.send!(c)) };
});
vi.mock("@/server/fullscript/membership-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./membership-generation")>();
  return { ...actual, createAwsFullscriptRevocationOutbox: (env?: NodeJS.ProcessEnv) => actual.createAwsFullscriptRevocationOutbox(env, (c) => tables.send!(c)) };
});
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { GET } from "../../app/api/live/fullscript/oauth/callback/route";
import { createFullscriptAuthorization, readFullscriptConfiguration } from "./client";
import { fictionalDynamoTables } from "./fictional-dynamo.fixture";
import { fullscriptPanelState } from "@/lib/fullscript-presentation";

const ORIGIN = "https://abcdefghij.execute-api.us-east-2.amazonaws.com";
const TOKENS = "fictional-token-table", FENCES = "fictional-fence-table";
const PRACTITIONER = "fictional-practitioner-0001";
type Person = { clinic: string; subject: string; idToken: string; email: string };
const person = (label: string, clinic: string = randomUUID()): Person => {
  const subject = randomUUID(), email = `fictional.${label}@example.test`;
  const idToken = ['{"alg":"RS256","kid":"fictional"}', JSON.stringify({ sub: subject, email, token_use: "id" })]
    .map((part) => Buffer.from(part).toString("base64url")).join(".") + ".fictional-signature";
  return { clinic, subject, idToken, email };
};
const actorKey = (who: Person) => createHash("sha256").update(`fullscript-actor/2\u0000${who.clinic}\u0000${who.subject}`).digest("hex");
const rowKey = (who: Person) => ({ pk: `ORG#${who.clinic}`, sk: `FULLSCRIPT#${actorKey(who)}` });

let db: ReturnType<typeof fictionalDynamoTables>, issued: number, revokeUp: boolean, order: string[], fetcher: ReturnType<typeof vi.fn>;
const revocations = () => (fetcher.mock.calls as Array<[string, RequestInit]>).filter(([url]) => url.endsWith("/oauth/revoke"))
  .map(([, init]) => JSON.parse(String(init.body)).token as string);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  db = fictionalDynamoTables(TOKENS, FENCES); issued = 0; revokeUp = true; order = [];
  tables.send = async (command) => {
    if (command instanceof PutCommand && String((command.input.Item as { sk?: unknown }).sk).startsWith("FULLSCRIPT_REVOCATION#")) order.push("queued");
    return db.send(command);
  };
  vi.stubEnv("FULLSCRIPT_ENVIRONMENT", "sandbox_us"); vi.stubEnv("FULLSCRIPT_CLIENT_ID", "fictional-client-id-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_CLIENT_SECRET", "fictional-client-secret-abcdefghijklmnopqrstuvwxyz");
  vi.stubEnv("FULLSCRIPT_REDIRECT_URI", "https://fictional.example.test/api/live/fullscript/oauth/callback");
  vi.stubEnv("FULLSCRIPT_OAUTH_STATE_SECRET", "fictional-state-secret-longer-than-32-characters");
  vi.stubEnv("FULLSCRIPT_TOKEN_TABLE", TOKENS); vi.stubEnv("FULLSCRIPT_MEMBERSHIP_FENCE_TABLE", FENCES); vi.stubEnv("AWS_REGION", "us-east-2");
  vi.stubEnv("CLINICAL_AWS_WORKFORCE_API_ORIGIN", ORIGIN);
  // The token store (nonces, disconnect) speaks the low-level client: the same fictional tables answer it.
  vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation((command: unknown) => db.send(command) as never);
  fetcher = vi.fn(async (url: string) => {
    if (url.startsWith(ORIGIN)) {
      const clinic = jar.cookies.find((cookie) => cookie.name === "aidp_org")!.value;
      return new Response(JSON.stringify({ data: [{ organization_id: clinic, name: "Fictional", slug: "f", role: "practitioner" }] }), { status: 200 });
    }
    if (url.endsWith("/oauth/revoke")) { order.push("revoked"); return new Response("{}", { status: revokeUp ? 200 : 503, headers: { "content-type": "application/json" } }); }
    issued++;
    return new Response(JSON.stringify({ oauth: { access_token: `fictional-access-token-${issued}-abcdefghijklmnopqrstuvwxyz`,
      refresh_token: `fictional-refresh-token-${issued}-abcdefghijklmnopqrstuvwxyz`, expires_in: 3600, created_at: new Date().toISOString(),
      scope: "catalog:read", resource_owner: { id: PRACTITIONER, type: "Practitioner" } } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); jar.cookies = []; });

async function connect(who: Person) {
  jar.cookies = [{ name: "aidp_at", value: who.idToken }, { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
    { name: "aidp_em", value: who.email }, { name: "aidp_org", value: who.clinic }];
  const { state } = createFullscriptAuthorization({ configuration: readFullscriptConfiguration(), actorKey: actorKey(who), organizationId: who.clinic,
    subject: who.subject, nonce: `fictional-nonce-${randomUUID()}` });
  const url = new URL("https://fictional.example.test/api/live/fullscript/oauth/callback");
  url.searchParams.set("state", state); url.searchParams.set("code", "fictional-authorization-code-abcdefghijklmnopqrstuvwxyz");
  const response = await GET(new NextRequest(url));
  return new URL(response.headers.get("location")!).searchParams.get("fullscript");
}
const outbox = () => [...db.rows(TOKENS).values()].filter((row) => String(row.sk).startsWith("FULLSCRIPT_REVOCATION#"));

describe("the callback for a Fullscript practitioner already connected to another Desktop account", () => {
  it("is refused by name; the new token is queued, then revoked; the first connection is byte-identical (failing before: connected)", async () => {
    const a = person("a"), b = person("b");
    expect(await connect(a)).toBe("connected");
    const first = structuredClone(db.get(TOKENS, rowKey(a)));
    order = [];
    expect(await connect(b)).toBe("practitioner_connected_elsewhere");
    expect(db.get(TOKENS, rowKey(b))).toBeUndefined();
    expect(db.get(TOKENS, rowKey(a))).toEqual(first);
    expect(revocations()).toEqual(["fictional-access-token-2-abcdefghijklmnopqrstuvwxyz"]);
    expect(order).toEqual(["queued", "revoked"]);
    expect(outbox()).toEqual([]); // revoked and confirmed: nothing left to retry
  });

  it("when Fullscript does not confirm the revocation, the refused token stays pending in the outbox for the reconciler", async () => {
    const a = person("a"), b = person("b");
    await connect(a);
    revokeUp = false;
    expect(await connect(b)).toBe("practitioner_connected_elsewhere");
    expect(outbox()).toEqual([expect.objectContaining({ pk: rowKey(b).pk, reason: "practitioner_connected_elsewhere", state: "pending", revocationQueue: "pending" })]);
    expect(JSON.parse(String(outbox()[0]!.payload)).accessToken).toBe("fictional-access-token-2-abcdefghijklmnopqrstuvwxyz");
  });

  it("when even the outbox write fails, the revocation is still attempted, and the one way left to orphan the token is logged without it", async () => {
    const a = person("a"), b = person("b");
    await connect(a);
    db.fault({ when: (command) => command instanceof PutCommand, mode: "fail_before" });
    revokeUp = false;
    expect(await connect(b)).toBe("practitioner_connected_elsewhere");
    expect(revocations()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("[fullscript.oauth.callback] issued token neither queued nor revoked", { reason: "practitioner_connected_elsewhere" });
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain("fictional-access-token");
  });

  it("a colleague in the same clinic is refused the same way; after the first account disconnects, the practitioner is free", async () => {
    const a = person("a"), colleague = person("colleague", a.clinic);
    await connect(a);
    expect(await connect(colleague)).toBe("practitioner_connected_elsewhere");
    const { disconnectFullscript } = await import("./runtime");
    jar.cookies = [{ name: "aidp_at", value: a.idToken }, { name: "aidp_exp", value: String(Date.now() + 3_600_000) },
      { name: "aidp_em", value: a.email }, { name: "aidp_org", value: a.clinic }];
    await disconnectFullscript({ signedIn: true, expired: false, expiresAt: null, orgId: a.clinic, email: a.email, token: a.idToken });
    expect(db.get(TOKENS, rowKey(a))).toBeUndefined();
    expect(await connect(colleague)).toBe("connected");
  });

  it("a disconnect Fullscript does not confirm keeps both the connection and the reservation: the practitioner stays taken", async () => {
    const a = person("a"), b = person("b");
    await connect(a);
    revokeUp = false;
    const { disconnectFullscript } = await import("./runtime");
    await expect(disconnectFullscript({ signedIn: true, expired: false, expiresAt: null, orgId: a.clinic, email: a.email, token: a.idToken }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(db.get(TOKENS, rowKey(a))).toBeDefined();
    revokeUp = true;
    expect(await connect(b)).toBe("practitioner_connected_elsewhere");
  });

  it("a lost install reply that cannot be confirmed says so, queues the token for the reconciler and does not revoke a token that may be in use", async () => {
    const a = person("a");
    // The install's transaction commits and its reply is lost, its retry and the read-back both fail.
    let installs = 0;
    db.fault({ when: (command) => (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && ++installs === 1, mode: "lost_reply" });
    db.fault({ when: (command) => (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand", mode: "fail_before" });
    db.fault({ when: (command) => (command as { constructor: { name: string }; input: { Key?: { sk?: string } } }).constructor.name === "GetCommand"
      && String((command as { input: { Key?: { sk?: string } } }).input.Key?.sk).startsWith("FULLSCRIPT#") && installs > 0, mode: "fail_before" });
    expect(await connect(a)).toBe("unconfirmed");
    expect(revocations()).toEqual([]);
    expect(outbox()).toEqual([expect.objectContaining({ reason: "install_unconfirmed", state: "pending" })]);
    expect(db.get(TOKENS, rowKey(a))).toBeDefined(); // it had committed: the reconciler finds it in use and leaves it
  });

  it("every new outcome is one the card knows and says nothing was saved", () => {
    for (const outcome of ["practitioner_connected_elsewhere", "unconfirmed"] as const) {
      expect(fullscriptPanelState({ posture: null, loadError: null, outcome, busy: null }).notice).toMatch(/nothing was saved/);
    }
  });
});
