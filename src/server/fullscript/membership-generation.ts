if (typeof window !== "undefined") throw new Error("Fullscript membership generation is server-only.");

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readMembershipFence, type ObservedMembershipFence } from "@/server/clinical-core/membership-fence";
import { FullscriptUnavailableError } from "./client";
import { parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";

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
 * fence table and these table permissions (GetItem, ConditionCheckItem, Query, Put/Delete/UpdateItem on the token table).
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

type Send = (command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand) => Promise<unknown>;
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

export type FullscriptRevocationReason = "membership_changed" | "unbound_connection";
export type FullscriptRevocationFailure = "provider_unavailable" | "environment_mismatch" | "malformed";
/** An outbox item as the reconciler and its operator see it: never a token. */
export type FullscriptRevocationItem = {
  organizationId: string; keyFingerprint: string; itemKey: { pk: string; sk: string }; reason: FullscriptRevocationReason;
  state: "pending" | "revoked"; attempts: number; lastFailure: FullscriptRevocationFailure | null; createdAt: string; revokedAt: string | null;
};
export interface FullscriptRevocationOutbox {
  /** Moves a saved connection, whole and unchanged, from its token row into a pending revocation item, in one transaction. */
  supersede(connection: StoredFullscriptConnection, reason: FullscriptRevocationReason): Promise<"moved" | "already_gone">;
  pending(organizationId: string): Promise<Array<{ item: FullscriptRevocationItem; connection: StoredFullscriptConnection | null }>>;
  settle(item: FullscriptRevocationItem, outcome: { revoked: true } | { revoked: false; failure: FullscriptRevocationFailure }): Promise<void>;
}
export const fingerprintOf = (pk: string, sk: string) => createHash("sha256").update(`fullscript-key/1\u0000${pk}\u0000${sk}`).digest("hex").slice(0, 16);

export function createAwsFullscriptRevocationOutbox(env: NodeJS.ProcessEnv = process.env, supplied?: Send): FullscriptRevocationOutbox | null {
  const settings = configured(env);
  if (!settings) return null;
  const send = sender(settings.region, supplied);
  const tokenKey = (connection: StoredFullscriptConnection) => ({ pk: `ORG#${connection.organizationId}`, sk: `FULLSCRIPT#${connection.actorKey}` });
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
      const outboxKey = { pk: key.pk, sk: `FULLSCRIPT_REVOCATION#${parsed.actorKey}#${parsed.connectedAt}` };
      try {
        await send(new TransactWriteCommand({ TransactItems: [
          { Delete: { TableName: settings.tokenTable, Key: key, ConditionExpression: "payload = :raw", ExpressionAttributeValues: { ":raw": raw } } },
          { Put: { TableName: settings.tokenTable, ConditionExpression: "attribute_not_exists(pk)", Item: { ...outboxKey,
            protocol: "fullscript-revocation/1", state: "pending", reason, attempts: 0, createdAt: new Date().toISOString(), payload: raw } } },
        ] }));
        return "moved";
      } catch (error) {
        if ((error as { name?: string }).name === "TransactionCanceledException") return "already_gone";
        throw new FullscriptUnavailableError();
      }
    },
    async pending(organizationId) {
      if (!UUID.test(organizationId)) throw new FullscriptUnavailableError();
      const result = await send(new QueryCommand({ TableName: settings.tokenTable, ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `ORG#${organizationId}`, ":prefix": "FULLSCRIPT_REVOCATION#" } })) as { Items?: Array<Record<string, unknown>> };
      return (result.Items ?? []).filter((row) => row.state === "pending").map((row) => {
        let connection: StoredFullscriptConnection | null = null;
        try { connection = parseStoredFullscriptConnection(JSON.parse(String(row.payload))); } catch { connection = null; }
        return { connection, item: { organizationId, keyFingerprint: fingerprintOf(String(row.pk), String(row.sk)),
          itemKey: { pk: String(row.pk), sk: String(row.sk) }, reason: row.reason as FullscriptRevocationReason, state: "pending" as const,
          attempts: Number(row.attempts ?? 0), lastFailure: (row.lastFailure as FullscriptRevocationFailure | undefined) ?? null,
          createdAt: String(row.createdAt), revokedAt: null } };
      });
    },
    async settle(item, outcome) {
      const at = new Date().toISOString();
      await send(new UpdateCommand({ TableName: settings.tokenTable, Key: item.itemKey, ConditionExpression: "#state = :pending",
        ...(outcome.revoked
          // The receipt keeps no token: the payload is removed only once Fullscript confirmed the revocation.
          ? { UpdateExpression: "SET #state = :revoked, revokedAt = :at REMOVE payload", ExpressionAttributeValues: { ":pending": "pending", ":revoked": "revoked", ":at": at } }
          : { UpdateExpression: "SET attempts = attempts + :one, lastFailure = :failure, lastAttemptAt = :at",
            ExpressionAttributeValues: { ":pending": "pending", ":one": 1, ":failure": outcome.failure, ":at": at } }),
        ExpressionAttributeNames: { "#state": "state" } }));
    },
  };
}

/**
 * Retries every pending revocation of one clinic. A provider failure stays pending with its attempt counted; nothing is
 * deleted on a failure, and the result carries fingerprints and codes, never a token.
 */
export async function reconcileFullscriptRevocations(input: {
  outbox: FullscriptRevocationOutbox; organizationId: string; environment: "sandbox_us" | "production_us";
  revoke: (accessToken: string) => Promise<void>;
}): Promise<Array<{ keyFingerprint: string; outcome: "revoked" | FullscriptRevocationFailure }>> {
  const results: Array<{ keyFingerprint: string; outcome: "revoked" | FullscriptRevocationFailure }> = [];
  for (const { item, connection } of await input.outbox.pending(input.organizationId)) {
    let failure: FullscriptRevocationFailure | null = null;
    if (!connection) failure = "malformed";
    else if (connection.environment !== input.environment) failure = "environment_mismatch";
    else {
      try { await input.revoke(connection.accessToken); } catch { failure = "provider_unavailable"; }
    }
    await input.outbox.settle(item, failure ? { revoked: false, failure } : { revoked: true });
    results.push({ keyFingerprint: item.keyFingerprint, outcome: failure ?? "revoked" });
  }
  return results;
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
