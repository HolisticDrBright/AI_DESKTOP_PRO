if (typeof window !== "undefined") throw new Error("Fullscript practitioner ownership is server-only.");

import { createHash } from "node:crypto";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { fingerprintOf, reconcileFullscriptRevocations, type FullscriptRevocationOutbox } from "./membership-generation";
import {
  FULLSCRIPT_OWNER_PROTOCOL, ownershipKeyOf, practitionerFingerprint, RESERVE_CONDITION, reservationFor, tokenRowKeyOf,
  type OwnershipReservation,
} from "./practitioner-reservation";
import { parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";

export {
  FullscriptInstallUnconfirmedError, FullscriptPractitionerConnectedElsewhereError, fullscriptOwnershipKey, practitionerFingerprint,
} from "./practitioner-reservation";

/**
 * The operator side of one Desktop account per Fullscript practitioner: the inventory of connections saved before
 * reservations existed, the reviewed reconciliation of duplicates, and the reviewed transfer. All three are source
 * only. Nothing here runs against a table until Codex runs it, on a PITR-restored copy first, and the transfer is
 * BLOCKED in source. None of them ever chooses which account keeps a practitioner: an operator decides, and the
 * decision is bound to the exact inventory it was made against.
 */
type Environment = StoredFullscriptConnection["environment"];
type Send = (command: GetCommand | PutCommand | TransactWriteCommand) => Promise<unknown>;
type RowKey = { pk: string; sk: string };
export type OwnershipRow = { key: RowKey; connection: StoredFullscriptConnection };

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** A label for one practitioner's group in a report: derived from the fingerprint, not reversible to it or the id. */
const groupLabel = (fingerprint: string) => createHash("sha256").update(`fullscript-owner-group/1\u0000${fingerprint}`).digest("hex").slice(0, 16);

/**
 * Every saved connection row of one Fullscript environment, grouped by the practitioner it names, against the
 * reservations that exist. The caller reads the rows' payloads (to learn the practitioner) from a restored copy; the
 * answer carries only fingerprints and counts: no token, provider id, clinic, account key or email.
 *
 *   - `collisions`: a practitioner saved under two or more accounts. Each is an operator decision.
 *   - `unreserved`: a practitioner saved under one account with no reservation (installed before reservations). Until
 *     the reviewed plan reserves it, a second account could still connect that practitioner.
 *   - `stale`: a reservation naming a row that is not saved (its token queued, or the row gone), counted only.
 */
export function inventoryFullscriptPractitionerOwnership(input: {
  environment: Environment; rows: readonly OwnershipRow[]; reservations: readonly OwnershipReservation[];
}) {
  const byPractitioner = new Map<string, OwnershipRow[]>();
  for (const row of input.rows) {
    const connection = parseStoredFullscriptConnection(row.connection);
    if (connection.environment !== input.environment || row.key.pk !== tokenRowKeyOf(connection).pk || row.key.sk !== tokenRowKeyOf(connection).sk) continue;
    const fingerprint = practitionerFingerprint(connection.environment, connection.resourceOwner.id);
    byPractitioner.set(fingerprint, [...byPractitioner.get(fingerprint) ?? [], row]);
  }
  const reservationOf = new Map(input.reservations.map((reservation) => [reservation.pk.replace(/^FULLSCRIPT_OWNER#/, ""), reservation]));
  const collisions: Array<{ group: string; rows: number; rowFingerprints: string[]; reserved: string | null }> = [];
  const unreservedRows: string[] = [];
  for (const [fingerprint, rows] of byPractitioner) {
    const reservation = reservationOf.get(fingerprint);
    const reserved = reservation ? rows.find((row) => row.key.pk === reservation.ownerPk && row.key.sk === reservation.ownerSk) : undefined;
    const rowFingerprints = rows.map((row) => fingerprintOf(row.key.pk, row.key.sk)).sort();
    if (rows.length > 1) collisions.push({ group: groupLabel(fingerprint), rows: rows.length, rowFingerprints,
      reserved: reserved ? fingerprintOf(reserved.key.pk, reserved.key.sk) : null });
    else if (!reservation) unreservedRows.push(rowFingerprints[0]!);
  }
  collisions.sort((a, b) => a.group.localeCompare(b.group));
  unreservedRows.sort();
  const saved = new Set(input.rows.map((row) => `${row.key.pk}|${row.key.sk}`));
  const stale = input.reservations.filter((reservation) => !saved.has(`${reservation.ownerPk}|${reservation.ownerSk}`)).length;
  const planDigest = sha256(["fullscript-ownership-plan/1", input.environment, collisions, unreservedRows]);
  return { environment: input.environment, rows: input.rows.length, collisions, unreserved: unreservedRows.length, unreservedRows, stale, planDigest };
}
export type FullscriptOwnershipInventory = ReturnType<typeof inventoryFullscriptPractitionerOwnership>;
/** One operator decision per collision: the row fingerprint that keeps the practitioner, or null to revoke them all. */
export type OwnershipDecision = { group: string; keep: string | null };

/** What the reviewer signs: the exact inventory and every decision on it. Any change to either is a different digest. */
export function ownershipReconciliationDigest(inventory: FullscriptOwnershipInventory, decisions: readonly OwnershipDecision[]) {
  return sha256(["fullscript-ownership-reconciliation/1", inventory.planDigest,
    [...decisions].map((decision) => [decision.group, decision.keep]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

/**
 * Executes a reviewed ownership reconciliation. Refused unless every collision has exactly one decision naming one of
 * its own rows (or none), and the reviewed digest is exactly this inventory and these decisions. Then, per group, every
 * row that does not keep the practitioner is moved, unchanged, into the revocation outbox (`duplicate_practitioner`);
 * the kept row, and each unreserved row, gets its reservation (create-only, or replacing only a reservation that named
 * one of the rows just queued); and the outbox is reconciled with Fullscript. The answer carries fingerprints only.
 */
export async function executeReviewedFullscriptOwnershipReconciliation(input: {
  environment: Environment; rows: readonly OwnershipRow[]; reservations: readonly OwnershipReservation[];
  decisions: readonly OwnershipDecision[]; reviewedDigest: string;
  send: Send; tokenTable: string; outbox: FullscriptRevocationOutbox; revoke: (accessToken: string) => Promise<void>;
}) {
  const inventory = inventoryFullscriptPractitionerOwnership(input);
  const decided = new Map(input.decisions.map((decision) => [decision.group, decision]));
  if (decided.size !== input.decisions.length || input.decisions.some((decision) => {
    const group = inventory.collisions.find((collision) => collision.group === decision.group);
    return !group || (decision.keep !== null && !group.rowFingerprints.includes(decision.keep));
  })) return { executed: false as const, reason: "decision_invalid" as const, inventory };
  if (inventory.collisions.some((collision) => !decided.has(collision.group))) return { executed: false as const, reason: "group_undecided" as const, inventory };
  if (!HEX64.test(input.reviewedDigest) || input.reviewedDigest !== ownershipReconciliationDigest(inventory, input.decisions)) {
    return { executed: false as const, reason: "plan_not_reviewed" as const, inventory };
  }
  const rowOf = new Map(input.rows.map((row) => [fingerprintOf(row.key.pk, row.key.sk), row]));
  const groups: Array<{ group: string; queued: number; reserved: "reserved" | "already" | "held_by_another" | "none" }> = [];
  const organizations = new Set<string>();
  for (const collision of inventory.collisions) {
    const keep = decided.get(collision.group)!.keep;
    const queued: StoredFullscriptConnection[] = [];
    for (const fingerprint of collision.rowFingerprints) {
      if (fingerprint === keep) continue;
      const connection = rowOf.get(fingerprint)!.connection;
      if (await input.outbox.supersede(connection, "duplicate_practitioner") === "moved") { queued.push(connection); organizations.add(connection.organizationId); }
    }
    groups.push({ group: collision.group, queued: queued.length,
      reserved: keep === null ? "none" : await reserve(input, rowOf.get(keep)!.connection, queued) });
  }
  let unreserved = 0;
  for (const fingerprint of inventory.unreservedRows) if (await reserve(input, rowOf.get(fingerprint)!.connection, []) === "reserved") unreserved++;
  const results = [];
  for (const organizationId of organizations) {
    results.push(...await reconcileFullscriptRevocations({ outbox: input.outbox, organizationId, environment: input.environment, revoke: input.revoke }));
  }
  const { unreservedRows: _rows, ...report } = inventory;
  return { executed: true as const, inventory: report, groups, unreservedReserved: unreserved, results };
}

async function reserve(input: { send: Send; tokenTable: string }, connection: StoredFullscriptConnection, queued: readonly StoredFullscriptConnection[]) {
  const key = tokenRowKeyOf(connection), item = reservationFor(connection, new Date().toISOString());
  try {
    await input.send(new PutCommand({ TableName: input.tokenTable, Item: item, ConditionExpression: RESERVE_CONDITION,
      ExpressionAttributeValues: { ":ownerPk": key.pk, ":ownerSk": key.sk } }));
    return "reserved" as const;
  } catch (error) {
    if ((error as { name?: unknown }).name !== "ConditionalCheckFailedException") throw error;
  }
  const current = (await input.send(new GetCommand({ TableName: input.tokenTable, Key: ownershipKeyOf(connection), ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  const displaced = queued.find((other) => current?.ownerPk === tokenRowKeyOf(other).pk && current?.ownerSk === tokenRowKeyOf(other).sk);
  if (!current || !displaced) return "held_by_another" as const;
  // The reservation named a row the reviewed decision just queued: replace exactly that reservation, nothing newer.
  await input.send(new PutCommand({ TableName: input.tokenTable, Item: item, ConditionExpression: "ownerPk = :ownerPk AND ownerSk = :ownerSk AND reservedAt = :reservedAt",
    ExpressionAttributeValues: { ":ownerPk": current.ownerPk, ":ownerSk": current.ownerSk, ":reservedAt": current.reservedAt } }));
  return "reserved" as const;
}

/**
 * A reviewed transfer of one practitioner to a named Desktop account. BLOCKED in source; the release is Codex's,
 * together with an operator surface behind the MFA-protected operator sign-in. Never implicit:
 *   - the current owner's saved row must already be out of use, queued for revocation in the outbox (a live or
 *     superseded row still holding the token refuses: `owner_row_not_queued`);
 *   - the reservation is replaced only if it is still exactly the one read (its `reservedAt`), and names the target
 *     account with no connection yet (`connectedAt: null`), so only that account can install it next;
 *   - an append-only audit item is written in the same transaction.
 */
export const FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE: "blocked" | "qualification" = "blocked";
export async function transferFullscriptPractitionerOwnership(input: {
  send: Send; tokenTable: string; environment: Environment; practitionerFingerprint: string;
  to: { actorKey: string; organizationId: string }; reviewedBy: string; reason: string; release?: "blocked" | "qualification"; now?: () => Date;
}): Promise<{ transferred: true } | { transferred: false; reason: "not_released" | "request_invalid" | "not_reserved" | "already_owner" | "owner_row_not_queued" | "conflict" }> {
  if ((input.release ?? FULLSCRIPT_OWNERSHIP_TRANSFER_RELEASE) !== "qualification") return { transferred: false, reason: "not_released" };
  if (!HEX64.test(input.practitionerFingerprint) || !HEX64.test(input.to.actorKey) || !UUID.test(input.to.organizationId)
    || !/^[A-Za-z0-9 ._@'-]{3,80}$/.test(input.reviewedBy) || input.reason.trim().length < 10 || input.reason.length > 300) {
    return { transferred: false, reason: "request_invalid" };
  }
  const key = { pk: `FULLSCRIPT_OWNER#${input.practitionerFingerprint}`, sk: "OWNER" };
  const get = async (target: RowKey) => (await input.send(new GetCommand({ TableName: input.tokenTable, Key: target, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item;
  const current = await get(key);
  if (!current || current.protocol !== FULLSCRIPT_OWNER_PROTOCOL) return { transferred: false, reason: "not_reserved" };
  const target = tokenRowKeyOf(input.to);
  if (current.ownerPk === target.pk && current.ownerSk === target.sk) return { transferred: false, reason: "already_owner" };
  const ownerPk = String(current.ownerPk), ownerSk = String(current.ownerSk);
  if (await get({ pk: ownerPk, sk: ownerSk })) return { transferred: false, reason: "owner_row_not_queued" };
  if (typeof current.connectedAt === "string") {
    const queued = await get({ pk: ownerPk, sk: `FULLSCRIPT_REVOCATION#${ownerSk.replace(/^FULLSCRIPT#/, "")}#${current.connectedAt}` });
    if (!queued) return { transferred: false, reason: "owner_row_not_queued" };
  }
  const at = (input.now?.() ?? new Date()).toISOString();
  const transfer = { from: fingerprintOf(ownerPk, ownerSk), reviewedBy: input.reviewedBy, reason: input.reason.trim(), at };
  const next: OwnershipReservation = { ...key, sk: "OWNER", protocol: FULLSCRIPT_OWNER_PROTOCOL, ownerPk: target.pk, ownerSk: target.sk,
    connectedAt: null, reservedAt: at, transfer };
  try {
    await input.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: input.tokenTable, Item: next, ConditionExpression: "ownerPk = :ownerPk AND ownerSk = :ownerSk AND reservedAt = :reservedAt",
        ExpressionAttributeValues: { ":ownerPk": ownerPk, ":ownerSk": ownerSk, ":reservedAt": current.reservedAt } } },
      { Put: { TableName: input.tokenTable, ConditionExpression: "attribute_not_exists(pk)",
        Item: { pk: `FULLSCRIPT_OWNER_AUDIT#${input.practitionerFingerprint}`, sk: `TRANSFER#${at}`, protocol: "fullscript-owner-transfer/1",
          ...transfer, to: fingerprintOf(target.pk, target.sk) } } },
    ] }));
  } catch (error) {
    if ((error as { name?: unknown }).name === "TransactionCanceledException") return { transferred: false, reason: "conflict" };
    throw error;
  }
  return { transferred: true };
}
