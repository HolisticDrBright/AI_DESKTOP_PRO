import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { membershipFenceKey, MEMBERSHIP_FENCE_PROTOCOL } from "@/server/clinical-core/membership-fence";
import type { RequestSession } from "@/server/session";
import { exchangeFullscriptAuthorizationCode, FullscriptGrantRefusedError, FullscriptUnavailableError, readFullscriptConfiguration } from "./client";
import { createAwsFullscriptConnectionAdmission } from "./connection-admission";
import type { StoredFullscriptConnection } from "./token-store";

/**
 * Reconnecting over a saved Fullscript connection, at the token write. Before this change the install overwrote any
 * saved row for the same account and clinic: a live connection was silently replaced (a different Fullscript account
 * could take over) and the replaced token stayed valid at Fullscript with no row left to revoke it from. Now a live
 * connection is never replaced, and a superseded one is queued for revocation in the same transaction.
 * Fictional subjects, clinics, tokens and tables only.
 */
const subject = randomUUID(), clinic = randomUUID(), actorKey = "a".repeat(64);
const token = [{ alg: "RS256" }, { sub: subject, token_use: "id" }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
const session: RequestSession = { signedIn: true, expired: false, expiresAt: null, orgId: clinic, email: "fictional@example.test", token };
const actor = { actorKey, organizationId: clinic };
const connection = (label: string, connectedAt = new Date().toISOString()): StoredFullscriptConnection => ({ ...actor,
  accessToken: `fictional-access-token-${label}-abcdefghijklmnopqrstuvwxyz`,
  refreshToken: `fictional-refresh-token-${label}-abcdefghijklmnopqrstuvwxyz`,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: ["catalog:read"],
  resourceOwner: { id: `fictional-practitioner-${label}`, type: "Practitioner" }, environment: "sandbox_us", connectedAt,
});
const env = { FULLSCRIPT_TOKEN_TABLE: "fictional-token-table", FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: "fictional-fence-table",
  AWS_REGION: "us-east-2", NODE_ENV: "test" as const };
const id = (k: { pk: string; sk: string }) => `${k.pk}|${k.sk}`;

/** A fictional table with all-or-nothing transactions: every condition is checked against its own item first. */
function fictionalTable() {
  const records = new Map<string, Record<string, unknown>>();
  const fenceKeys = [membershipFenceKey({ kind: "subject", subject }), membershipFenceKey({ kind: "clinic", organizationId: clinic })];
  for (const k of fenceKeys) records.set(id(k), { ...k, fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: 1 });
  const tokenKey = id({ pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}` });
  const transactions: TransactWriteCommand[] = [];
  const send = vi.fn(async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) return { Item: records.get(id(command.input.Key as { pk: string; sk: string })) };
    transactions.push(command);
    const writes = command.input.TransactItems ?? [];
    for (const write of writes) {
      if (write.ConditionCheck) {
        const present = records.get(id(write.ConditionCheck.Key as { pk: string; sk: string }));
        const expected = write.ConditionCheck.ExpressionAttributeValues;
        if (!present || present.fenceProtocol !== expected?.[":fenceProtocol"] || present.fenceVersion !== expected?.[":fenceVersion"]
          || present.pendingChanges !== undefined) throw Object.assign(new Error("fictional"), { name: "TransactionCanceledException" });
      }
      if (write.Put) {
        const present = records.get(id(write.Put.Item as { pk: string; sk: string }));
        if (write.Put.ConditionExpression === "attribute_not_exists(pk)" && present) throw Object.assign(new Error("fictional"), { name: "TransactionCanceledException" });
        if (write.Put.ConditionExpression === "payload = :previous" && present?.payload !== write.Put.ExpressionAttributeValues?.[":previous"]) {
          throw Object.assign(new Error("fictional"), { name: "TransactionCanceledException" });
        }
      }
    }
    for (const write of writes) if (write.Put) records.set(id(write.Put.Item as { pk: string; sk: string }), write.Put.Item as Record<string, unknown>);
    return {};
  });
  const admission = createAwsFullscriptConnectionAdmission(env, send)!;
  /** A membership change that settled: the subject's fence moves on, so connections made before it are superseded. */
  const membershipChanged = () => { const k = id(fenceKeys[0]!); records.set(k, { ...records.get(k), fenceVersion: Number(records.get(k)!.fenceVersion) + 1 }); };
  const outbox = () => [...records.entries()].filter(([k]) => k.includes("|FULLSCRIPT_REVOCATION#")).map(([, v]) => v);
  return { records, send, transactions, admission, tokenKey, membershipChanged, outbox };
}

describe("reconnecting over a saved Fullscript connection", () => {
  it("observes whether the saved connection is live: none, live, or superseded", async () => {
    const t = fictionalTable();
    expect(await t.admission.observe(session, actor)).toMatchObject({ previousPayload: null, previousCurrent: null });
    await t.admission.install(connection("first"), await t.admission.observe(session, actor));
    expect(await t.admission.observe(session, actor)).toMatchObject({ previousCurrent: true });
    t.membershipChanged();
    expect(await t.admission.observe(session, actor)).toMatchObject({ previousCurrent: false });
  });

  it("a live connection is never replaced: refused before any write, and the saved token stays exactly as it was", async () => {
    const t = fictionalTable();
    await t.admission.install(connection("first"), await t.admission.observe(session, actor));
    const saved = t.records.get(t.tokenKey);
    const writes = t.transactions.length;
    // A second tab, a direct API call, or a different Fullscript account: the same refusal, by name.
    await expect(t.admission.install(connection("second"), await t.admission.observe(session, actor)))
      .rejects.toMatchObject({ name: "FullscriptAlreadyConnectedError" });
    expect(t.transactions).toHaveLength(writes);
    expect(t.records.get(t.tokenKey)).toEqual(saved);
    expect(t.outbox()).toEqual([]);
  });

  it("a superseded connection is queued for revocation in the same transaction as the new one, never overwritten and forgotten", async () => {
    const t = fictionalTable();
    const first = connection("first", new Date(Date.now() - 86_400_000).toISOString());
    await t.admission.install(first, await t.admission.observe(session, actor));
    const raw = t.records.get(t.tokenKey)!.payload as string;
    t.membershipChanged();
    const writes = t.transactions.length;
    await t.admission.install(connection("second"), await t.admission.observe(session, actor));
    expect(t.transactions).toHaveLength(writes + 1);
    expect(t.outbox()).toEqual([expect.objectContaining({ pk: `ORG#${clinic}`, sk: `FULLSCRIPT_REVOCATION#${actorKey}#${first.connectedAt}`,
      protocol: "fullscript-revocation/1", state: "pending", reason: "membership_changed", attempts: 0, payload: raw })]);
    expect(JSON.parse(t.records.get(t.tokenKey)!.payload as string)).toMatchObject({ accessToken: connection("second").accessToken });
  });

  it("a connection saved before generations existed is superseded too, and queued the same way", async () => {
    const t = fictionalTable();
    const legacy = JSON.stringify(connection("legacy"));
    t.records.set(t.tokenKey, { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}`, payload: legacy });
    const observed = await t.admission.observe(session, actor);
    expect(observed.previousCurrent).toBe(false);
    await t.admission.install(connection("second"), observed);
    expect(t.outbox().map((item) => item.payload)).toEqual([legacy]);
  });

  it("if the saved row changes after observation, nothing moves: the whole transaction cancels", async () => {
    const t = fictionalTable();
    await t.admission.install(connection("first"), await t.admission.observe(session, actor));
    t.membershipChanged();
    const observed = await t.admission.observe(session, actor);
    const other = { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${actorKey}`, payload: JSON.stringify(connection("other-tab")) };
    t.records.set(t.tokenKey, other);
    await expect(t.admission.install(connection("second"), observed)).rejects.toBeInstanceOf(FullscriptUnavailableError);
    expect(t.records.get(t.tokenKey)).toEqual(other);
    expect(t.outbox()).toEqual([]);
  });
});

describe("a refused grant is told apart from an outage", () => {
  const configuration = readFullscriptConfiguration({ NODE_ENV: "test", FULLSCRIPT_ENVIRONMENT: "sandbox_us",
    FULLSCRIPT_CLIENT_ID: "fictional-client-id-abcdefghijklmnopqrstuvwxyz", FULLSCRIPT_CLIENT_SECRET: "fictional-client-secret-abcdefghijklmnopqrstuvwxyz",
    FULLSCRIPT_REDIRECT_URI: "https://fictional.example.test/api/live/fullscript/oauth/callback",
    FULLSCRIPT_OAUTH_STATE_SECRET: "fictional-state-secret-longer-than-32-characters" });
  const exchange = (fetcher: typeof fetch) => exchangeFullscriptAuthorizationCode({ configuration, code: "fictional-code-abcdefghijklmnopqrstuvwxyz", fetcher })
    .then(() => null, (error: unknown) => error);
  const answer = (status: number) => (async () => new Response('{"error":"fictional"}', { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("Fullscript refusing the grant (400) is a refused grant", async () => {
    const failure = await exchange(answer(400));
    expect(failure).toBeInstanceOf(FullscriptGrantRefusedError);
    expect(failure).toBeInstanceOf(FullscriptUnavailableError);
  });

  it("our client refused (401), an outage (5xx) or no answer at all says nothing about the practitioner's account", async () => {
    for (const fetcher of [answer(401), answer(500), answer(503), (async () => { throw new TypeError("fictional network"); }) as unknown as typeof fetch]) {
      const failure = await exchange(fetcher);
      expect(failure).toBeInstanceOf(FullscriptUnavailableError);
      expect(failure).not.toBeInstanceOf(FullscriptGrantRefusedError);
    }
  });
});
