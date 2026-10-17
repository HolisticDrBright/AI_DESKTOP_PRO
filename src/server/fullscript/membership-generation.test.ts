import { createHash, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { membershipFenceKey, MEMBERSHIP_FENCE_PROTOCOL } from "@/server/clinical-core/membership-fence";
import {
  createAwsFullscriptGenerationReader, createAwsFullscriptRevocationOutbox, executeReviewedFullscriptReconciliation, fingerprintOf,
  generationFromFences, inventoryFullscriptConnections, reconcileFullscriptRevocations, sameGeneration,
} from "./membership-generation";
import type { StoredFullscriptConnection } from "./token-store";

const env = { FULLSCRIPT_TOKEN_TABLE: "fictional-token-table", FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: "fictional-fence-table", AWS_REGION: "us-east-2", NODE_ENV: "test" as const };
const clinic = randomUUID(), subject = randomUUID();
const ACCESS = "fictional-access-token-abcdefghijklmnopqrstuvwxyz";
const connection = (actorKey: string, accessToken = ACCESS): StoredFullscriptConnection => ({ actorKey, organizationId: clinic, environment: "sandbox_us",
  accessToken, refreshToken: "fictional-refresh-token-abcdefghijklmnopqrstuvwxyz", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  connectedAt: "2026-10-16T00:00:00.000Z", resourceOwner: { id: "fictional-practitioner-id", type: "Practitioner" }, scope: ["catalog:read"],
  membershipGeneration: { protocol: "fullscript-generation/1", subjectFence: 1, clinicFence: 1 } });
const v2Key = (sub: string) => createHash("sha256").update(`fullscript-actor/2\u0000${clinic}\u0000${sub}`).digest("hex");

/** A fictional DynamoDB document table: one map per table, the conditions these writes use, all-or-nothing transactions. */
function fictionalTables() {
  const tables = { "fictional-token-table": new Map<string, Record<string, unknown>>(), "fictional-fence-table": new Map<string, Record<string, unknown>>() };
  const id = (key: { pk: unknown; sk: unknown }) => `${String(key.pk)}|${String(key.sk)}`;
  const table = (name: unknown) => tables[name as keyof typeof tables];
  const cancel = () => Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
  const send = vi.fn(async (command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand | DeleteCommand | PutCommand) => {
    if (command instanceof GetCommand) return { Item: table(command.input.TableName).get(id(command.input.Key as never)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      return { Items: [...table(command.input.TableName).values()].filter((row) => row.pk === values[":pk"] && String(row.sk).startsWith(values[":prefix"]!)) };
    }
    if (command instanceof TransactWriteCommand) {
      const items = command.input.TransactItems ?? [];
      for (const item of items) {
        if (item.Delete) {
          const present = table(item.Delete.TableName).get(id(item.Delete.Key as never));
          if (!present || present.payload !== item.Delete.ExpressionAttributeValues?.[":raw"]) throw cancel();
        }
        if (item.Put && table(item.Put.TableName).has(id(item.Put.Item as never))) throw cancel();
      }
      for (const item of items) {
        if (item.Delete) table(item.Delete.TableName).delete(id(item.Delete.Key as never));
        if (item.Put) table(item.Put.TableName).set(id(item.Put.Item as never), { ...item.Put.Item });
      }
      return {};
    }
    if (command instanceof UpdateCommand) {
      const rows = table(command.input.TableName), key = id(command.input.Key as never), present = rows.get(key);
      const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
      if (!present || present.state !== values[":pending"]) throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
      if (String(command.input.UpdateExpression).includes("REMOVE payload")) {
        const { payload: _payload, ...rest } = present;
        rows.set(key, { ...rest, state: values[":revoked"], revokedAt: values[":at"] });
      } else rows.set(key, { ...present, attempts: Number(present.attempts) + 1, lastFailure: values[":failure"], lastAttemptAt: values[":at"] });
      return {};
    }
    throw new Error("unexpected_command");
  });
  const saveToken = (value: StoredFullscriptConnection) => tables["fictional-token-table"].set(`ORG#${clinic}|FULLSCRIPT#${value.actorKey}`,
    { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${value.actorKey}`, payload: JSON.stringify(value) });
  return { tables, send, saveToken, tokens: tables["fictional-token-table"] };
}

describe("the membership generation a connection was installed under", () => {
  const fence = (state: "absent" | "settled" | "changing", version = 1) =>
    (state === "absent" ? { key: { pk: "p", sk: "s" }, state } : { key: { pk: "p", sk: "s" }, state, version }) as never;
  it("is the two fence versions: absent counts as 0, and a change in flight is no generation at all", () => {
    expect(generationFromFences([fence("absent"), fence("settled", 4)])).toEqual({ protocol: "fullscript-generation/1", subjectFence: 0, clinicFence: 4 });
    expect(() => generationFromFences([fence("changing", 3), fence("settled")])).toThrow();
    const current = generationFromFences([fence("settled", 3), fence("settled", 5)]);
    expect(sameGeneration(current, current)).toBe(true);
    expect(sameGeneration(undefined, current)).toBe(false);
    expect(sameGeneration({ ...current, subjectFence: 1 }, current)).toBe(false);
  });

  it("is read strongly consistent from the fence table, and is unavailable while a change is in flight or with no fence table", async () => {
    const fixture = fictionalTables();
    const reader = createAwsFullscriptGenerationReader(env, fixture.send)!;
    expect(await reader.current(subject, clinic)).toEqual({ protocol: "fullscript-generation/1", subjectFence: 0, clinicFence: 0 });
    const key = membershipFenceKey({ kind: "subject", subject });
    fixture.tables["fictional-fence-table"].set(`${key.pk}|${key.sk}`, { ...key, fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: 4 });
    expect(await reader.current(subject, clinic)).toMatchObject({ subjectFence: 4 });
    expect((fixture.send.mock.calls[0]![0] as GetCommand).input.ConsistentRead).toBe(true);
    fixture.tables["fictional-fence-table"].set(`${key.pk}|${key.sk}`, { ...key, fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: 5, pendingChanges: new Set([randomUUID()]) });
    await expect(reader.current(subject, clinic)).rejects.toThrow();
    expect(createAwsFullscriptGenerationReader({ ...env, FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: "" }, fixture.send)).toBeNull();
  });
});

describe("the revocation outbox", () => {
  it("moves a superseded connection, whole and unchanged, from its token row into one pending item, in one transaction", async () => {
    const fixture = fictionalTables();
    const outbox = createAwsFullscriptRevocationOutbox(env, fixture.send)!;
    const saved = connection(v2Key(subject));
    fixture.saveToken(saved);
    expect(await outbox.supersede(saved, "membership_changed")).toBe("moved");
    expect(fixture.tokens.has(`ORG#${clinic}|FULLSCRIPT#${saved.actorKey}`)).toBe(false);
    const [pending] = await outbox.pending(clinic);
    expect(pending!.item).toMatchObject({ reason: "membership_changed", state: "pending", attempts: 0 });
    expect(JSON.stringify(pending!.item)).not.toContain(ACCESS);
    expect(pending!.connection).toEqual(saved);
    expect(await outbox.supersede(saved, "membership_changed")).toBe("already_gone");
    expect(await outbox.pending(clinic)).toHaveLength(1);
  });

  it("race: a refresh that rotated the row first wins; the stale copy moves nothing, and the new row is judged on its own read", async () => {
    const fixture = fictionalTables();
    const outbox = createAwsFullscriptRevocationOutbox(env, fixture.send)!;
    const before = connection(v2Key(subject));
    fixture.saveToken({ ...before, accessToken: "fictional-rotated-access-token-abcdefghij" });
    expect(await outbox.supersede(before, "membership_changed")).toBe("already_gone");
    expect(fixture.tokens.size).toBe(1);
    expect(await outbox.pending(clinic)).toEqual([]);
  });

  it("race: a supersede first leaves no row for a later refresh or disconnect to write back (the token store's replace needs the row)", async () => {
    const fixture = fictionalTables();
    const outbox = createAwsFullscriptRevocationOutbox(env, fixture.send)!;
    const saved = connection(v2Key(subject));
    fixture.saveToken(saved);
    await outbox.supersede(saved, "membership_changed");
    expect([...fixture.tokens.keys()].filter((key) => key.includes("|FULLSCRIPT#"))).toEqual([]);
  });

  it("reconciles with Fullscript: a failure stays pending with its attempt counted; success leaves a receipt without the token", async () => {
    const fixture = fictionalTables();
    const outbox = createAwsFullscriptRevocationOutbox(env, fixture.send)!;
    const saved = connection(v2Key(subject));
    fixture.saveToken(saved);
    await outbox.supersede(saved, "membership_changed");
    let providerUp = false;
    const revoke = vi.fn(async (token: string) => { expect(token).toBe(ACCESS); if (!providerUp) throw new Error("fictional provider down"); });
    const failed = await reconcileFullscriptRevocations({ outbox, organizationId: clinic, environment: "sandbox_us", revoke });
    expect(failed).toEqual([{ keyFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/), outcome: "provider_unavailable" }]);
    const [stillPending] = await outbox.pending(clinic);
    expect(stillPending!.item).toMatchObject({ state: "pending", attempts: 1, lastFailure: "provider_unavailable" });
    expect(stillPending!.connection?.accessToken).toBe(ACCESS); // kept until Fullscript confirms; never a deletion receipt
    expect(await reconcileFullscriptRevocations({ outbox, organizationId: clinic, environment: "production_us", revoke }))
      .toEqual([{ keyFingerprint: expect.any(String), outcome: "environment_mismatch" }]);
    providerUp = true;
    expect((await reconcileFullscriptRevocations({ outbox, organizationId: clinic, environment: "sandbox_us", revoke }))[0]!.outcome).toBe("revoked");
    expect(await outbox.pending(clinic)).toEqual([]);
    const receipt = [...fixture.tokens.values()].find((row) => String(row.sk).startsWith("FULLSCRIPT_REVOCATION#"))!;
    expect(receipt).toMatchObject({ state: "revoked", attempts: 2 });
    expect(JSON.stringify(receipt)).not.toContain(ACCESS);
    expect(JSON.stringify([failed])).not.toContain(ACCESS);
  });
});

describe("the inventory and the reviewed reconciliation of older rows", () => {
  const emailKey = createHash("sha256").update(`${clinic}\u0000fictional.legacy@example.test`).digest("hex");
  const former = randomUUID();
  const rows = [{ pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${v2Key(subject)}` }, { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${emailKey}` },
    { pk: `ORG#${clinic}`, sk: `FULLSCRIPT#${v2Key(former)}` }, { pk: `ORG#${clinic}`, sk: "FULLSCRIPT_NONCE#x" }];

  it("classifies by key alone and reports fingerprints, never a key, subject, email or token", () => {
    const inventory = inventoryFullscriptConnections({ organizationId: clinic, rows, currentMemberSubjects: [subject] });
    expect(inventory.entries.map((entry) => entry.binding).sort()).toEqual(["current_member", "unbound", "unbound"]);
    expect(inventory.unbound).toBe(2);
    const text = JSON.stringify(inventory);
    for (const secret of [emailKey, v2Key(subject), subject, former, "fictional.legacy"]) expect(text).not.toContain(secret);
    expect(inventoryFullscriptConnections({ organizationId: clinic, rows: [...rows].reverse(), currentMemberSubjects: [subject] }).planDigest).toBe(inventory.planDigest);
  });

  it("refuses an unreviewed or stale plan; a reviewed one moves each unbound row unchanged and never claims or re-keys it", async () => {
    const fixture = fictionalTables();
    const outbox = createAwsFullscriptRevocationOutbox(env, fixture.send)!;
    const legacy = connection(emailKey, "fictional-legacy-access-token-abcdefghij");
    const formerRow = connection(v2Key(former), "fictional-former-access-token-abcdefghij");
    const currentRow = connection(v2Key(subject));
    for (const value of [legacy, formerRow, currentRow]) fixture.saveToken(value);
    const readRow = async (row: { sk: string }) => [legacy, formerRow, currentRow].find((value) => row.sk === `FULLSCRIPT#${value.actorKey}`) ?? null;
    const revoke = vi.fn(async () => undefined);
    const input = { organizationId: clinic, rows, currentMemberSubjects: [subject], readRow, outbox, environment: "sandbox_us" as const, revoke };
    expect(await executeReviewedFullscriptReconciliation({ ...input, reviewedPlanDigest: "0".repeat(64) })).toMatchObject({ executed: false, reason: "plan_not_reviewed" });
    const stale = inventoryFullscriptConnections({ organizationId: clinic, rows: rows.slice(0, 2), currentMemberSubjects: [subject] }).planDigest;
    expect(await executeReviewedFullscriptReconciliation({ ...input, reviewedPlanDigest: stale })).toMatchObject({ executed: false });
    expect(revoke).not.toHaveBeenCalled();
    const reviewed = inventoryFullscriptConnections(input).planDigest;
    const done = await executeReviewedFullscriptReconciliation({ ...input, reviewedPlanDigest: reviewed });
    expect(done).toMatchObject({ executed: true });
    expect(revoke).toHaveBeenCalledTimes(2);
    // The current member's row is untouched; no row was written under a new key.
    expect(fixture.tokens.get(`ORG#${clinic}|FULLSCRIPT#${currentRow.actorKey}`)).toBeDefined();
    const puts = fixture.send.mock.calls.map((call) => call[0]).filter((command) => command instanceof TransactWriteCommand)
      .flatMap((command) => (command as TransactWriteCommand).input.TransactItems ?? []).map((item) => item.Put?.Item?.sk).filter(Boolean);
    expect(puts.every((sk) => String(sk).startsWith("FULLSCRIPT_REVOCATION#"))).toBe(true);
    expect(JSON.stringify(done)).not.toMatch(/fictional-(legacy|former)-access-token|fictional\.legacy/);
    expect(done.results!.map((result) => result.keyFingerprint).sort()).toEqual(
      [fingerprintOf(`ORG#${clinic}`, `FULLSCRIPT_REVOCATION#${legacy.actorKey}#${legacy.connectedAt}`),
        fingerprintOf(`ORG#${clinic}`, `FULLSCRIPT_REVOCATION#${formerRow.actorKey}#${formerRow.connectedAt}`)].sort());
  });
});
