if (typeof window !== "undefined") throw new Error("Fullscript membership generation is server-only.");

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readMembershipFence, type ObservedMembershipFence } from "@/server/clinical-core/membership-fence";
import { FullscriptUnavailableError } from "./client";
import { parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";
import { namesConnection, ownershipKeyOf, RELEASE_CONDITION, releaseValues, tokenRowKeyOf } from "./practitioner-reservation";

/**
 * A saved Fullscript connection is bound to the membership generation it was installed under
 * (`fullscript-generation/1`): the subject's and the clinic's membership-fence versions the installation's own
 * TransactWrite held. Every authority-reducing change (a membership removed, suspended or demoted; the identity
 * disabled; the clinic suspended) moves one of those fences before it commits. So a connection whose recorded generation
 * is not the current one was made under authority that has since been reduced, and it is never used again: not when the
 * member is re-added, not when the clinic is reinstated, not after a refresh. It moves, whole, into a revocation outbox
 * item (pending until Fullscript confirms the revocation), and the practitioner is asked to reconnect.
 *
 * A connection saved before generations existed carries none and is treated the same way (fail closed).
 *
 * This is one release unit with the install fence (connection-admission.ts), the BLOCKED fence guard and its writer, the
 * fence table and these table permissions (GetItem, ConditionCheckItem, Put/DeleteItem on the token table for the
 * hosted Desktop; Query on the queue index and UpdateItem for the BLOCKED reconciler only, revocation-reconciler.ts).
 * Without the fence table the connection is not used at all.
 */
export const FULLSCRIPT_GENERATION_PROTOCOL = "fullscript-generation/1";
export const FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE = "Reconnect Fullscript: your clinic access changed since this connection was made, so it isn't used.";
export type FullscriptMembershipGeneration = { protocol: typeof FULLSCRIPT_GENERATION_PROTOCOL; subjectFence: number; clinicFence: number };

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generationFromFences(fences: readonly [ObservedMembershipFence, ObservedMembershipFence]): FullscriptMembershipGeneration {
  const version = (fence: ObservedMembershipFence) => {
    if (fence.state === "changing") throw new FullscriptUnavailableError();
    return fence.state === "absent" ? 0 : fence.version;
  };
  return { protocol: FULLSCRIPT_GENERATION_PROTOCOL, subjectFence: version(fences[0]), clinicFence: version(fences[1]) };
}
export function sameGeneration(recorded: FullscriptMembershipGeneration | undefined, current: FullscriptMembershipGeneration): boolean {
  return recorded?.protocol === FULLSCRIPT_GENERATION_PROTOCOL && recorded.subjectFence === current.subjectFence
    && recorded.clinicFence === current.clinicFence;
}

type Send = (command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand | DeleteCommand | PutCommand) => Promise<unknown>;
const configured = (env: NodeJS.ProcessEnv) => {
  const tokenTable = env.FULLSCRIPT_TOKEN_TABLE?.trim() ?? "", fenceTable = env.FULLSCRIPT_MEMBERSHIP_FENCE_TABLE?.trim() ?? "";
  const region = env.AWS_REGION?.trim() || env.CLINICAL_AWS_REGION?.trim() || "";
  if (!TABLE_NAME.test(tokenTable) || !TABLE_NAME.test(fenceTable) || !REGION.test(region) || tokenTable === "disabled" || fenceTable === "disabled") return null;
  return { tokenTable, fenceTable, region };
};
const sender = (region: string, supplied?: Send): Send => {
  if (supplied) return supplied;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  return (command) => client.send(command as never);
};

export interface FullscriptGenerationReader { current(subject: string, organizationId: string): Promise<FullscriptMembershipGeneration> }
/** Strongly consistent reads of both fences. A fence with a change in flight answers unavailable, never "current". */
export function createAwsFullscriptGenerationReader(env: NodeJS.ProcessEnv = process.env, supplied?: Send): FullscriptGenerationReader | null {
  const settings = configured(env);
  if (!settings) return null;
  const send = sender(settings.region, supplied);
  return {
    async current(subject, organizationId) {
      if (!UUID.test(subject) || !UUID.test(organizationId)) throw new FullscriptUnavailableError();
      try {
        const fences = await Promise.all([
          readMembershipFence((command) => send(command as GetCommand), settings.fenceTable, { kind: "subject", subject }),
          readMembershipFence((command) => send(command as GetCommand), settings.fenceTable, { kind: "clinic", organizationId }),
        ]);
        return generationFromFences(fences as [ObservedMembershipFence, ObservedMembershipFence]);
      } catch { throw new FullscriptUnavailableError(); }
    },
  };
}

/**
 * Why a token is in the outbox:
 *   - `membership_changed`, `unbound_connection`: a saved connection moved out of use (above; the reviewed migration);
 *   - `install_refused`: Fullscript issued a token and the install refused it (a live connection appeared, the fences
 *     moved, the account's access changed); `practitioner_connected_elsewhere`: the same, because the practitioner is
 *     reserved by another Desktop account. Each is queued BEFORE the callback revokes it, so a failed revocation leaves
 *     a pending item rather than an orphan token;
 *   - `install_unconfirmed`: the install's reply was lost and could not be confirmed; it is revoked only if no saved
 *     connection holds it;
 *   - `duplicate_practitioner`: a reviewed reconciliation of connections made before reservations existed.
 */
export type FullscriptRevocationReason = "membership_changed" | "unbound_connection" | "install_refused" | "practitioner_connected_elsewhere"
  | "install_unconfirmed" | "duplicate_practitioner";
export type FullscriptRevocationFailure = "provider_unavailable" | "environment_mismatch" | "malformed";
/** The sparse index the reconciler reads: pending items only, by when they are next due. KEYS_ONLY, so it holds no token. */
export const FULLSCRIPT_REVOCATION_QUEUE_INDEX = "RevocationQueue";
const QUEUE_PENDING = "pending";
/** The retry schedule: 5 minutes, doubling per failed attempt, at most a day apart. */
export const revocationBackoffMs = (attempts: number) => Math.min(5 * 60_000 * 2 ** Math.max(0, attempts), 24 * 3_600_000);

/** An outbox item in `fullscript-revocation/1`, pending and due now, with the exact stored bytes of the connection. */
export function revocationOutboxItem(key: { pk: string; sk: string }, reason: FullscriptRevocationReason, payload: string, at: string) {
  return { ...key, protocol: "fullscript-revocation/1", state: "pending", reason, attempts: 0, createdAt: at, payload,
    revocationQueue: QUEUE_PENDING, nextAttemptAt: at };
}
export const revocationOutboxKey = (connection: Pick<StoredFullscriptConnection, "organizationId" | "actorKey" | "connectedAt">) =>
  ({ pk: `ORG#${connection.organizationId}`, sk: `FULLSCRIPT_REVOCATION#${connection.actorKey}#${connection.connectedAt}` });
/** An outbox item as the reconciler and its operator see it: never a token. */
export type FullscriptRevocationItem = {
  organizationId: string; keyFingerprint: string; itemKey: { pk: string; sk: string }; reason: FullscriptRevocationReason;
  state: "pending" | "revoked"; attempts: number; lastFailure: FullscriptRevocationFailure | null; createdAt: string; revokedAt: string | null;
};
export type PendingRevocation = { item: FullscriptRevocationItem; connection: StoredFullscriptConnection | null };
export interface FullscriptRevocationOutbox {
  /** Moves a saved connection, whole and unchanged, from its token row into a pending revocation item, in one transaction. */
  supersede(connection: StoredFullscriptConnection, reason: FullscriptRevocationReason): Promise<"moved" | "already_gone">;
  /** Records an issued token that was never saved (create-only), before anything tries to revoke it. */
  queue(connection: StoredFullscriptConnection, reason: FullscriptRevocationReason): Promise<FullscriptRevocationItem>;
  /** Removes a pending item whose token Fullscript has just confirmed revoked, or that a saved connection holds. */
  discard(item: FullscriptRevocationItem): Promise<void>;
  /** Whether the account's saved connection holds exactly this token: then it is in use, and is never revoked from here. */
  holds(connection: StoredFullscriptConnection): Promise<boolean>;
  pending(organizationId: string): Promise<PendingRevocation[]>;
  /** Pending items across every clinic that are due, oldest first, from the queue index; at most `limit`. */
  due(limit: number, now: Date): Promise<{ items: PendingRevocation[]; more: boolean }>;
  /**
   * Records the outcome. A confirmed revocation removes the token from the item and, in the same transaction, releases
   * the practitioner's reservation if it still names exactly this connection. A failure counts the attempt and sets
   * the next one by the backoff; the item stays pending and keeps its token.
   */
  settle(item: FullscriptRevocationItem, outcome: { revoked: true } | { revoked: false; failure: FullscriptRevocationFailure },
    connection?: StoredFullscriptConnection | null): Promise<void>;
}
export const fingerprintOf = (pk: string, sk: string) => createHash("sha256").update(`fullscript-key/1\u0000${pk}\u0000${sk}`).digest("hex").slice(0, 16);

export function createAwsFullscriptRevocationOutbox(env: NodeJS.ProcessEnv = process.env, supplied?: Send): FullscriptRevocationOutbox | null {
  const settings = configured(env);
  if (!settings) return null;
  const send = sender(settings.region, supplied);
  const tokenKey = tokenRowKeyOf;
  const toPending = (row: Record<string, unknown>): PendingRevocation => {
    let connection: StoredFullscriptConnection | null = null;
    try { connection = parseStoredFullscriptConnection(JSON.parse(String(row.payload))); } catch { connection = null; }
    const organizationId = String(row.pk).replace(/^ORG#/, "");
    return { connection, item: { organizationId, keyFingerprint: fingerprintOf(String(row.pk), String(row.sk)),
      itemKey: { pk: String(row.pk), sk: String(row.sk) }, reason: row.reason as FullscriptRevocationReason, state: "pending" as const,
      attempts: Number(row.attempts ?? 0), lastFailure: (row.lastFailure as FullscriptRevocationFailure | undefined) ?? null,
      createdAt: String(row.createdAt), revokedAt: null } };
  };
  return {
    async supersede(connection, reason) {
      const parsed = parseStoredFullscriptConnection(connection);
      const key = tokenKey(parsed);
      const current = await send(new GetCommand({ TableName: settings.tokenTable, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
      if (!current?.Item) return "already_gone";
      const raw = current.Item.payload;
      if (typeof raw !== "string"
        || JSON.stringify(parseStoredFullscriptConnection(JSON.parse(raw), { actorKey: parsed.actorKey, organizationId: parsed.organizationId }))
          !== JSON.stringify(parsed)) {
        return "already_gone"; // rotated or replaced since it was read: the newer row is judged on its own next read
      }
      const outboxKey = revocationOutboxKey(parsed);
      try {
        await send(new TransactWriteCommand({ TransactItems: [
          { Delete: { TableName: settings.tokenTable, Key: key, ConditionExpression: "payload = :raw", ExpressionAttributeValues: { ":raw": raw } } },
          { Put: { TableName: settings.tokenTable, ConditionExpression: "attribute_not_exists(pk)",
            Item: revocationOutboxItem(outboxKey, reason, raw, new Date().toISOString()) } },
        ] }));
        return "moved";
      } catch (error) {
        if ((error as { name?: string }).name === "TransactionCanceledException") return "already_gone";
        throw new FullscriptUnavailableError();
      }
    },
    async queue(connection, reason) {
      const parsed = parseStoredFullscriptConnection(connection);
      const key = revocationOutboxKey(parsed), at = new Date().toISOString();
      await send(new PutCommand({ TableName: settings.tokenTable, ConditionExpression: "attribute_not_exists(pk)",
        Item: revocationOutboxItem(key, reason, JSON.stringify(parsed), at) }));
      return toPending({ ...key, reason, attempts: 0, createdAt: at }).item;
    },
    async discard(item) {
      await send(new DeleteCommand({ TableName: settings.tokenTable, Key: item.itemKey, ConditionExpression: "#state = :pending",
        ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":pending": "pending" } }));
    },
    async holds(connection) {
      const current = await send(new GetCommand({ TableName: settings.tokenTable, Key: tokenKey(connection), ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
      if (typeof current?.Item?.payload !== "string") return false;
      try { return parseStoredFullscriptConnection(JSON.parse(current.Item.payload)).accessToken === connection.accessToken; } catch { return false; }
    },
    async pending(organizationId) {
      if (!UUID.test(organizationId)) throw new FullscriptUnavailableError();
      const result = await send(new QueryCommand({ TableName: settings.tokenTable, ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ORG#${organizationId}`, ":prefix": "FULLSCRIPT_REVOCATION#" } })) as { Items?: Array<Record<string, unknown>> };
      return (result.Items ?? []).filter((row) => row.state === "pending").map(toPending);
    },
    async due(limit, now) {
      const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
      const result = await send(new QueryCommand({ TableName: settings.tokenTable, IndexName: FULLSCRIPT_REVOCATION_QUEUE_INDEX, Limit: bounded,
        KeyConditionExpression: "revocationQueue = :pending AND nextAttemptAt <= :now",
        ExpressionAttributeValues: { ":pending": QUEUE_PENDING, ":now": now.toISOString() } })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: unknown };
      const items: PendingRevocation[] = [];
      // The index holds keys only; each item is read whole, strongly consistent, from the table.
      for (const key of result.Items ?? []) {
        if (typeof key.pk !== "string" || typeof key.sk !== "string" || !key.pk.startsWith("ORG#") || !key.sk.startsWith("FULLSCRIPT_REVOCATION#")) continue;
        const row = await send(new GetCommand({ TableName: settings.tokenTable, Key: { pk: key.pk, sk: key.sk }, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
        if (row?.Item?.state === "pending") items.push(toPending(row.Item));
      }
      return { items, more: result.LastEvaluatedKey !== undefined };
    },
    async settle(item, outcome, connection) {
      const at = new Date().toISOString();
      const names = { "#state": "state" };
      if (!outcome.revoked) {
        await send(new UpdateCommand({ TableName: settings.tokenTable, Key: item.itemKey, ConditionExpression: "#state = :pending",
          UpdateExpression: "SET attempts = attempts + :one, lastFailure = :failure, lastAttemptAt = :at, nextAttemptAt = :next",
          ExpressionAttributeValues: { ":pending": "pending", ":one": 1, ":failure": outcome.failure, ":at": at,
            ":next": new Date(Date.parse(at) + revocationBackoffMs(item.attempts)).toISOString() },
          ExpressionAttributeNames: names }));
        return;
      }
      // The receipt keeps no token, and leaves the queue: the payload is removed only once Fullscript confirmed the revocation.
      const receipt = { TableName: settings.tokenTable, Key: item.itemKey, ConditionExpression: "#state = :pending",
        UpdateExpression: "SET #state = :revoked, revokedAt = :at REMOVE payload, revocationQueue, nextAttemptAt",
        ExpressionAttributeValues: { ":pending": "pending", ":revoked": "revoked", ":at": at }, ExpressionAttributeNames: names };
      const ownership = connection ? ownershipKeyOf(connection) : null;
      const reservation = ownership
        ? (await send(new GetCommand({ TableName: settings.tokenTable, Key: ownership, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item
        : undefined;
      if (!connection || !ownership || !namesConnection(reservation, connection)) { await send(new UpdateCommand(receipt)); return; }
      // The practitioner is free again only for the exact connection whose token Fullscript has just confirmed revoked.
      await send(new TransactWriteCommand({ TransactItems: [
        { Update: receipt },
        { Delete: { TableName: settings.tokenTable, Key: ownership, ConditionExpression: RELEASE_CONDITION, ExpressionAttributeValues: releaseValues(connection) } },
      ] }));
    },
  };
}

/**
 * Retries every pending revocation of one clinic. A provider failure stays pending with its attempt counted; nothing is
 * deleted on a failure, and the result carries fingerprints and codes, never a token.
 */
export type FullscriptRevocationOutcome = "revoked" | "in_use" | FullscriptRevocationFailure;
export async function reconcileFullscriptRevocations(input: {
  outbox: FullscriptRevocationOutbox; organizationId: string; environment: "sandbox_us" | "production_us";
  revoke: (accessToken: string) => Promise<void>;
}): Promise<Array<{ keyFingerprint: string; outcome: FullscriptRevocationOutcome }>> {
  const results: Array<{ keyFingerprint: string; outcome: FullscriptRevocationOutcome }> = [];
  for (const pending of await input.outbox.pending(input.organizationId)) {
    results.push({ keyFingerprint: pending.item.keyFingerprint, outcome: await reconcileFullscriptRevocation({ ...input, pending }) });
  }
  return results;
}

/**
 * One pending item. A token the account's saved connection holds (an install whose reply was lost but which did
 * commit) is in use: it is never revoked from here, and the item is discarded. Otherwise Fullscript must confirm the
 * revocation before the item is settled; any failure leaves it pending, with its token, for the next attempt.
 */
export async function reconcileFullscriptRevocation(input: {
  outbox: FullscriptRevocationOutbox; pending: PendingRevocation; environment: "sandbox_us" | "production_us";
  revoke: (accessToken: string) => Promise<void>;
}): Promise<FullscriptRevocationOutcome> {
  const { item, connection } = input.pending;
  let failure: FullscriptRevocationFailure | null = null;
  if (!connection) failure = "malformed";
  else if (connection.environment !== input.environment) failure = "environment_mismatch";
  else {
    if (await input.outbox.holds(connection)) { await input.outbox.discard(item); return "in_use"; }
    try { await input.revoke(connection.accessToken); } catch { failure = "provider_unavailable"; }
  }
  await input.outbox.settle(item, failure ? { revoked: false, failure } : { revoked: true }, connection);
  return failure ?? "revoked";
}

/** One saved token row as the inventory sees it: its key only. The payload is never read here. */
export type FullscriptTokenRowKey = { pk: string; sk: string };
export type FullscriptInventoryEntry = { keyFingerprint: string; organizationId: string; binding: "current_member" | "unbound" };
/**
 * Classifies every saved connection row of a clinic by its key alone: bound to a current member's account
 * (`fullscript-actor/2` over that member's subject) or not. Unbound covers the older email-keyed rows and rows of former
 * members; neither is ever claimed or re-keyed. The answer carries a fingerprint per row and the plan digest an operator
 * reviews; no key, email, subject or token.
 */
export function inventoryFullscriptConnections(input: { organizationId: string; rows: readonly FullscriptTokenRowKey[]; currentMemberSubjects: readonly string[] }) {
  const bound = new Set(input.currentMemberSubjects.map((subject) =>
    `FULLSCRIPT#${createHash("sha256").update(`fullscript-actor/2\u0000${input.organizationId}\u0000${subject}`).digest("hex")}`));
  const entries: FullscriptInventoryEntry[] = input.rows
    .filter((row) => row.pk === `ORG#${input.organizationId}` && /^FULLSCRIPT#[a-f0-9]{64}$/.test(row.sk))
    .map((row) => ({ keyFingerprint: fingerprintOf(row.pk, row.sk), organizationId: input.organizationId, binding: bound.has(row.sk) ? "current_member" as const : "unbound" as const }))
    .sort((a, b) => a.keyFingerprint.localeCompare(b.keyFingerprint));
  const planDigest = createHash("sha256").update(JSON.stringify(["fullscript-reconciliation-plan/1", input.organizationId,
    entries.filter((entry) => entry.binding === "unbound").map((entry) => entry.keyFingerprint)])).digest("hex");
  return { entries, unbound: entries.filter((entry) => entry.binding === "unbound").length, planDigest };
}

/**
 * Executes a reviewed reconciliation: only when the operator's reviewed plan digest is exactly the inventory's current
 * one (a plan that changed since review is refused), each unbound row is moved, unchanged, into the revocation outbox,
 * and the outbox is reconciled with Fullscript. A row is never claimed, re-keyed or deleted without its pending item.
 */
export async function executeReviewedFullscriptReconciliation(input: {
  organizationId: string; rows: readonly FullscriptTokenRowKey[]; currentMemberSubjects: readonly string[]; reviewedPlanDigest: string;
  readRow: (row: FullscriptTokenRowKey) => Promise<StoredFullscriptConnection | null>;
  outbox: FullscriptRevocationOutbox; environment: "sandbox_us" | "production_us"; revoke: (accessToken: string) => Promise<void>;
}) {
  const inventory = inventoryFullscriptConnections(input);
  if (!/^[a-f0-9]{64}$/.test(input.reviewedPlanDigest) || input.reviewedPlanDigest !== inventory.planDigest) {
    return { executed: false as const, reason: "plan_not_reviewed" as const, inventory };
  }
  const unbound = new Set(inventory.entries.filter((entry) => entry.binding === "unbound").map((entry) => entry.keyFingerprint));
  for (const row of input.rows) {
    if (!unbound.has(fingerprintOf(row.pk, row.sk))) continue;
    const connection = await input.readRow(row);
    if (connection) await input.outbox.supersede(connection, "unbound_connection");
  }
  const results = await reconcileFullscriptRevocations({ outbox: input.outbox, organizationId: input.organizationId, environment: input.environment, revoke: input.revoke });
  return { executed: true as const, inventory, results };
}
