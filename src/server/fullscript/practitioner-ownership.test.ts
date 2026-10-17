import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { membershipFenceKey, MEMBERSHIP_FENCE_PROTOCOL } from "@/server/clinical-core/membership-fence";
import type { RequestSession } from "@/server/session";
import { createAwsFullscriptConnectionAdmission } from "./connection-admission";
import { fictionalDynamoTables } from "./fictional-dynamo.fixture";
import { createAwsFullscriptRevocationOutbox, fingerprintOf, reconcileFullscriptRevocations } from "./membership-generation";
import {
  FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE, executeReviewedFullscriptOwnershipReconciliation, fullscriptOwnershipKey,
  inventoryFullscriptPractitionerOwnership, ownershipReconciliationDigest, practitionerFingerprint, transferFullscriptPractitionerOwnership,
} from "./practitioner-ownership";
import { createAwsFullscriptTokenStore, type StoredFullscriptConnection } from "./token-store";

/**
 * One Desktop account per Fullscript practitioner (owner decision, 2026-10-16). Before this change nothing tied a
 * Fullscript practitioner to one Desktop account: a second account, in the same clinic or another, installed a
 * connection to the same practitioner and both used it. Now the install takes an ownership reservation keyed by the
 * practitioner, in the same transaction that makes the token usable, and a reservation held by another account cancels
 * that transaction. Fictional accounts, clinics, practitioners and tokens only.
 */
const TOKENS = "fictional-token-table", FENCES = "fictional-fence-table";
const env = { FULLSCRIPT_TOKEN_TABLE: TOKENS, FULLSCRIPT_MEMBERSHIP_FENCE_TABLE: FENCES, AWS_REGION: "us-east-2", NODE_ENV: "test" as const };
const PRACTITIONER = "fictional-practitioner-0001";

type Account = { session: RequestSession; actor: { actorKey: string; organizationId: string }; subject: string };
function account(organizationId = randomUUID()): Account {
  const subject = randomUUID();
  const token = [{ alg: "RS256" }, { sub: subject, token_use: "id" }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fictional-signature";
  const actorKey = createHash("sha256").update(`fullscript-actor/2\u0000${organizationId}\u0000${subject}`).digest("hex");
  return { subject, actor: { actorKey, organizationId },
    session: { signedIn: true, expired: false, expiresAt: null, orgId: organizationId, email: "fictional@example.test", token } };
}
let clock = Date.parse("2026-10-17T09:00:00.000Z");
const connection = (who: Account, label: string, practitioner = PRACTITIONER, environment: "sandbox_us" | "production_us" = "sandbox_us"): StoredFullscriptConnection => ({
  ...who.actor, environment, connectedAt: new Date(clock += 1000).toISOString(), installationId: randomUUID(),
  accessToken: `fictional-access-token-${label}-abcdefghijklmnopqrstuvwxyz`, refreshToken: `fictional-refresh-token-${label}-abcdefghijklmnopqrstuvwxyz`,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: ["catalog:read"], resourceOwner: { id: practitioner, type: "Practitioner" },
});
const rowKey = (who: Account) => ({ pk: `ORG#${who.actor.organizationId}`, sk: `FULLSCRIPT#${who.actor.actorKey}` });

function world() {
  const db = fictionalDynamoTables(TOKENS, FENCES);
  const admission = createAwsFullscriptConnectionAdmission(env, db.send as never)!;
  const outbox = createAwsFullscriptRevocationOutbox(env, db.send as never)!;
  const install = async (who: Account, value: StoredFullscriptConnection) => admission.install(value, await admission.observe(who.session, who.actor));
  /** A membership change that settled: the account's subject fence moves on, so its connection is superseded. */
  const membershipChanged = (who: Account) => {
    const key = membershipFenceKey({ kind: "subject", subject: who.subject });
    const present = db.get(FENCES, key);
    db.set(FENCES, { ...key, fenceProtocol: MEMBERSHIP_FENCE_PROTOCOL, fenceVersion: Number(present?.fenceVersion ?? 0) + 1 });
  };
  const reservation = (practitioner = PRACTITIONER, environment: "sandbox_us" | "production_us" = "sandbox_us") =>
    db.get(TOKENS, fullscriptOwnershipKey(environment, practitioner));
  const outboxItems = () => [...db.rows(TOKENS).values()].filter((row) => String(row.sk).startsWith("FULLSCRIPT_REVOCATION#"));
  /** The connection exactly as the install saved it (with the generation it was admitted under). */
  const saved = (who: Account) => JSON.parse(String(db.get(TOKENS, rowKey(who))!.payload)) as StoredFullscriptConnection;
  return { db, admission, outbox, install, membershipChanged, reservation, outboxItems, saved };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("one Desktop account per Fullscript practitioner, at the install", () => {
  it("a second account is refused by name, nothing is saved for it, and the first connection is byte-identical (failing before: both connected)", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "a"));
    const first = structuredClone(w.db.get(TOKENS, rowKey(a)));
    await expect(w.install(b, connection(b, "b"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
    expect(w.db.get(TOKENS, rowKey(b))).toBeUndefined();
    expect(w.db.get(TOKENS, rowKey(a))).toEqual(first);
  });

  it("the same clinic is no exception: another account in it is refused the same way", async () => {
    const w = world(), a = account(), colleague = account(a.actor.organizationId);
    await w.install(a, connection(a, "a"));
    await expect(w.install(colleague, connection(colleague, "c"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
    expect(w.db.get(TOKENS, rowKey(colleague))).toBeUndefined();
  });

  it("the reservation holds a fingerprint and the owning row's key: no token, no provider id", async () => {
    const w = world(), a = account();
    const value = connection(a, "a");
    await w.install(a, value);
    const held = w.reservation()!;
    expect(held).toMatchObject({ protocol: "fullscript-owner/1", ownerPk: rowKey(a).pk, ownerSk: rowKey(a).sk, connectedAt: value.connectedAt });
    expect(held.pk).toBe(`FULLSCRIPT_OWNER#${practitionerFingerprint("sandbox_us", PRACTITIONER)}`);
    const text = JSON.stringify(held);
    for (const secret of [PRACTITIONER, value.accessToken, value.refreshToken]) expect(text).not.toContain(secret);
  });

  it("is scoped by Fullscript environment: the sandbox and production practitioner are different reservations", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "a", PRACTITIONER, "sandbox_us"));
    await w.install(b, connection(b, "b", PRACTITIONER, "production_us"));
    expect(w.reservation(PRACTITIONER, "sandbox_us")?.ownerSk).toBe(rowKey(a).sk);
    expect(w.reservation(PRACTITIONER, "production_us")?.ownerSk).toBe(rowKey(b).sk);
  });

  it("race: two accounts installing the same practitioner at once: exactly one wins, the other is refused, one row exists", async () => {
    for (let round = 0; round < 6; round++) {
      const w = world(), a = account(), b = account();
      const [observedA, observedB] = await Promise.all([w.admission.observe(a.session, a.actor), w.admission.observe(b.session, b.actor)]);
      const outcomes = await Promise.allSettled([w.admission.install(connection(a, "a"), observedA), w.admission.install(connection(b, "b"), observedB)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((o) => o.status === "rejected").map((o) => (o as PromiseRejectedResult).reason.name)).toEqual(["FullscriptPractitionerConnectedElsewhereError"]);
      const winner = outcomes[0]!.status === "fulfilled" ? a : b;
      expect([...w.db.rows(TOKENS).keys()].filter((k) => k.includes("|FULLSCRIPT#"))).toEqual([`${rowKey(winner).pk}|${rowKey(winner).sk}`]);
      expect(w.reservation()!.ownerSk).toBe(rowKey(winner).sk);
    }
  });

  it("race: one account racing itself (two tabs) installs once; the second is refused as already connected", async () => {
    const w = world(), a = account();
    const [first, second] = await Promise.all([w.admission.observe(a.session, a.actor), w.admission.observe(a.session, a.actor)]);
    const winner = connection(a, "tab-one");
    const outcomes = await Promise.allSettled([w.admission.install(winner, first), w.admission.install(connection(a, "tab-two"), second)]);
    expect(outcomes[0]!.status).toBe("fulfilled");
    expect((outcomes[1] as PromiseRejectedResult).reason.name).toBe("FullscriptAlreadyConnectedError");
    expect(JSON.parse(String(w.db.get(TOKENS, rowKey(a))!.payload)).accessToken).toBe(winner.accessToken);
  });

  it("a lost reply after the install committed is confirmed by a re-read, not reported as a failure; a retry neither doubles nor steals", async () => {
    const w = world(), a = account(), b = account();
    w.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "lost_reply" });
    const value = connection(a, "a");
    await w.install(a, value);
    expect(JSON.parse(String(w.db.get(TOKENS, rowKey(a))!.payload)).installationId).toBe(value.installationId);
    await expect(w.install(a, connection(a, "retry"))).rejects.toMatchObject({ name: "FullscriptAlreadyConnectedError" });
    await expect(w.install(b, connection(b, "b"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
    expect(w.reservation()!.ownerSk).toBe(rowKey(a).sk);
  });

  it("a lost reply is retried once with the same request token, which applies at most once: one row, one reservation", async () => {
    const w = world(), a = account();
    w.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "fail_before" });
    const value = connection(a, "a");
    await w.install(a, value);
    const installs = w.db.commands.filter((command) => command instanceof TransactWriteCommand) as TransactWriteCommand[];
    expect(installs).toHaveLength(2);
    expect(new Set(installs.map((command) => command.input.ClientRequestToken))).toEqual(new Set([value.installationId]));
    expect(JSON.parse(String(w.db.get(TOKENS, rowKey(a))!.payload)).installationId).toBe(value.installationId);
    expect(w.reservation()?.ownerSk).toBe(rowKey(a).sk);
  });

  it("a lost reply that cannot be confirmed either way is its own refusal, committed or not (the caller queues the token instead of guessing)", async () => {
    const committed = world(), a = account();
    const observed = await committed.admission.observe(a.session, a.actor);
    committed.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "lost_reply" });
    committed.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "fail_before" });
    committed.db.fault({ when: (command) => (command as { input?: { TableName?: string } }).input?.TableName === TOKENS, mode: "fail_before" });
    await expect(committed.admission.install(connection(a, "a"), observed)).rejects.toMatchObject({ name: "FullscriptInstallUnconfirmedError" });
    expect(committed.db.get(TOKENS, rowKey(a))).toBeDefined(); // it did commit: the caller must not assume otherwise
    const absent = world(), b = account();
    absent.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "fail_before" });
    absent.db.fault({ when: (command) => command instanceof TransactWriteCommand, mode: "fail_before" });
    await expect(absent.install(b, connection(b, "b"))).rejects.toMatchObject({ name: "FullscriptInstallUnconfirmedError" });
    expect(absent.db.get(TOKENS, rowKey(b))).toBeUndefined();
    expect(absent.reservation()).toBeUndefined();
  });
});

describe("ownership across a membership change, a disconnect and a confirmed revocation", () => {
  it("the same account reconnecting over its superseded row keeps and renews its own reservation; another account still cannot take it", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "old"));
    w.membershipChanged(a);
    const renewed = connection(a, "new");
    await w.install(a, renewed);
    expect(w.reservation()).toMatchObject({ ownerSk: rowKey(a).sk, connectedAt: renewed.connectedAt });
    expect(w.outboxItems()).toHaveLength(1);
    await expect(w.install(b, connection(b, "b"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
  });

  it("a superseded row queued for revocation still holds the practitioner until Fullscript confirms; then the reservation is released", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "old"));
    const old = w.saved(a);
    w.membershipChanged(a);
    expect(await w.outbox.supersede(old, "membership_changed")).toBe("moved");
    await expect(w.install(b, connection(b, "early"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
    let up = false;
    const revoke = vi.fn(async () => { if (!up) throw new Error("fictional provider down"); });
    await reconcileFullscriptRevocations({ outbox: w.outbox, organizationId: a.actor.organizationId, environment: "sandbox_us", revoke });
    expect(w.reservation()?.ownerSk).toBe(rowKey(a).sk); // a failed revocation releases nothing
    up = true;
    await reconcileFullscriptRevocations({ outbox: w.outbox, organizationId: a.actor.organizationId, environment: "sandbox_us", revoke });
    expect(w.reservation()).toBeUndefined();
    await w.install(b, connection(b, "b"));
    expect(w.reservation()?.ownerSk).toBe(rowKey(b).sk);
  });

  it("a confirmed revocation of an older connection never releases the reservation the same account renewed since", async () => {
    const w = world(), a = account(), b = account();
    const old = connection(a, "old");
    await w.install(a, old);
    w.membershipChanged(a);
    const renewed = connection(a, "new");
    await w.install(a, renewed); // queues the old row in the same transaction
    await reconcileFullscriptRevocations({ outbox: w.outbox, organizationId: a.actor.organizationId, environment: "sandbox_us", revoke: async () => undefined });
    expect(w.reservation()).toMatchObject({ ownerSk: rowKey(a).sk, connectedAt: renewed.connectedAt });
    await expect(w.install(b, connection(b, "b"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
  });

  it("a confirmed disconnect releases the reservation in the same transaction as the row delete", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "a"));
    const value = w.saved(a);
    vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation((command: unknown) => w.db.send(command) as never);
    const store = createAwsFullscriptTokenStore(env)!;
    expect(await store.delete(value)).toBe(true);
    const deletes = w.db.commands.filter((command) => command instanceof TransactWriteItemsCommand) as TransactWriteItemsCommand[];
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.TransactItems!.map((entry) => entry.Delete?.Key?.pk?.S))
      .toEqual([rowKey(a).pk, `FULLSCRIPT_OWNER#${practitionerFingerprint("sandbox_us", PRACTITIONER)}`]);
    expect(w.db.get(TOKENS, rowKey(a))).toBeUndefined();
    expect(w.reservation()).toBeUndefined();
    await w.install(b, connection(b, "b"));
  });

  it("a disconnect whose row has no reservation of its own (an older duplicate) deletes only the row and leaves the other account's reservation", async () => {
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "a"));
    const older = connection(b, "older");
    w.db.set(TOKENS, { ...rowKey(b), payload: JSON.stringify(older) }); // saved before reservations existed
    vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation((command: unknown) => w.db.send(command) as never);
    expect(await createAwsFullscriptTokenStore(env)!.delete(older)).toBe(true);
    expect(w.db.get(TOKENS, rowKey(b))).toBeUndefined();
    expect(w.reservation()?.ownerSk).toBe(rowKey(a).sk);
  });
});

describe("an explicit, reviewed transfer (BLOCKED), never a silent one", () => {
  const review = { reviewedBy: "fictional-operator", reason: "fictional practitioner moved to a new Desktop account" };
  it("is blocked in source", async () => {
    expect(FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE).toBe("blocked");
    const w = world(), a = account(), b = account();
    await w.install(a, connection(a, "a"));
    await expect(transferFullscriptPractitionerOwnership({ send: w.db.send as never, tokenTable: TOKENS, environment: "sandbox_us",
      practitionerFingerprint: practitionerFingerprint("sandbox_us", PRACTITIONER), to: b.actor, ...review }))
      .resolves.toMatchObject({ transferred: false, reason: "not_released" });
    expect(w.reservation()?.ownerSk).toBe(rowKey(a).sk);
  });

  it("refuses while the current owner's row is still live; after it is queued for revocation, moves the reservation to the named account only", async () => {
    const w = world(), a = account(), b = account(), c = account();
    await w.install(a, connection(a, "a"));
    const old = w.saved(a);
    const transfer = () => transferFullscriptPractitionerOwnership({ send: w.db.send as never, tokenTable: TOKENS, environment: "sandbox_us",
      practitionerFingerprint: practitionerFingerprint("sandbox_us", PRACTITIONER), to: b.actor, release: "qualification", ...review });
    await expect(transfer()).resolves.toMatchObject({ transferred: false, reason: "owner_row_not_queued" });
    w.membershipChanged(a);
    await w.outbox.supersede(old, "membership_changed");
    await expect(transfer()).resolves.toMatchObject({ transferred: true });
    expect(w.reservation()).toMatchObject({ ownerSk: rowKey(b).sk, connectedAt: null, transfer: { reviewedBy: review.reviewedBy } });
    await expect(w.install(c, connection(c, "c"))).rejects.toMatchObject({ name: "FullscriptPractitionerConnectedElsewhereError" });
    await w.install(b, connection(b, "b"));
    // The later confirmed revocation of the old token does not release the transferred reservation.
    await reconcileFullscriptRevocations({ outbox: w.outbox, organizationId: a.actor.organizationId, environment: "sandbox_us", revoke: async () => undefined });
    expect(w.reservation()?.ownerSk).toBe(rowKey(b).sk);
  });
});

describe("existing duplicates: inventory and a reviewed reconciliation that never picks a winner", () => {
  async function duplicates() {
    const w = world(), a = account(), b = account(), solo = account();
    const rowA = connection(a, "dup-a"), rowB = connection(b, "dup-b"), rowSolo = connection(solo, "solo", "fictional-practitioner-0002");
    for (const [who, value] of [[a, rowA], [b, rowB], [solo, rowSolo]] as const) w.db.set(TOKENS, { ...rowKey(who), payload: JSON.stringify(value) });
    const rows = [a, b, solo].map((who) => ({ key: rowKey(who), connection: [rowA, rowB, rowSolo].find((value) => value.actorKey === who.actor.actorKey)! }));
    return { w, a, b, solo, rowA, rowB, rowSolo, rows };
  }

  it("reports a practitioner held by two accounts as a group of fingerprints and counts: no token, provider id, clinic or key", async () => {
    const { rows, rowA, rowB, a, b } = await duplicates();
    const inventory = inventoryFullscriptPractitionerOwnership({ environment: "sandbox_us", rows, reservations: [] });
    expect(inventory.collisions).toHaveLength(1);
    expect(inventory.collisions[0]).toMatchObject({ rows: 2, reserved: null });
    expect(inventory.collisions[0]!.rowFingerprints).toHaveLength(2);
    expect(inventory.unreserved).toBe(1);
    const text = JSON.stringify(inventory);
    for (const secret of [PRACTITIONER, rowA.accessToken, rowB.accessToken, a.actor.organizationId, b.actor.actorKey]) expect(text).not.toContain(secret);
  });

  it("refuses an unreviewed plan, or one that leaves a group undecided; never chooses on its own", async () => {
    const { w, rows } = await duplicates();
    const inventory = inventoryFullscriptPractitionerOwnership({ environment: "sandbox_us", rows, reservations: [] });
    const revoke = vi.fn(async () => undefined);
    const base = { environment: "sandbox_us" as const, rows, reservations: [], send: w.db.send as never, tokenTable: TOKENS, outbox: w.outbox, revoke };
    expect(await executeReviewedFullscriptOwnershipReconciliation({ ...base, decisions: [], reviewedDigest: ownershipReconciliationDigest(inventory, []) }))
      .toMatchObject({ executed: false, reason: "group_undecided" });
    const decision = [{ group: inventory.collisions[0]!.group, keep: inventory.collisions[0]!.rowFingerprints[0]! }];
    expect(await executeReviewedFullscriptOwnershipReconciliation({ ...base, decisions: decision, reviewedDigest: "0".repeat(64) }))
      .toMatchObject({ executed: false, reason: "plan_not_reviewed" });
    expect(revoke).not.toHaveBeenCalled();
    expect(w.outboxItems()).toEqual([]);
  });

  it("a reviewed decision queues every other row of the group for revocation, unchanged, and reserves the kept row", async () => {
    const { w, rows, a, b, rowA, rowB } = await duplicates();
    const inventory = inventoryFullscriptPractitionerOwnership({ environment: "sandbox_us", rows, reservations: [] });
    const group = inventory.collisions[0]!;
    const keepA = rows.find((row) => row.key.sk === rowKey(a).sk)!;
    const keep = group.rowFingerprints.find((fingerprint) => fingerprint === fingerprintOf(keepA.key.pk, keepA.key.sk))!;
    const decisions = [{ group: group.group, keep }];
    const revoke = vi.fn(async () => undefined);
    const done = await executeReviewedFullscriptOwnershipReconciliation({ environment: "sandbox_us", rows, reservations: [], send: w.db.send as never,
      tokenTable: TOKENS, outbox: w.outbox, revoke, decisions, reviewedDigest: ownershipReconciliationDigest(inventory, decisions) });
    expect(done).toMatchObject({ executed: true });
    expect(revoke).toHaveBeenCalledExactlyOnceWith(rowB.accessToken);
    expect(w.db.get(TOKENS, rowKey(b))).toBeUndefined();
    expect(JSON.parse(String(w.db.get(TOKENS, rowKey(a))!.payload))).toEqual(rowA);
    expect(w.reservation()).toMatchObject({ ownerSk: rowKey(a).sk, connectedAt: rowA.connectedAt });
    expect(JSON.stringify(done)).not.toMatch(/fictional-access-token|fictional-practitioner-000/);
  });
});
