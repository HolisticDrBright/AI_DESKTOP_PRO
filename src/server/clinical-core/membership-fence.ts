if (typeof window !== "undefined") throw new Error("membership-fence is server-only");

import { randomUUID } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * The workforce membership fence (`membership-fence/1`): a DynamoDB item per workforce subject and per clinic that
 * every authority-reducing change to the rows the current-membership check reads must move BEFORE it can commit.
 *
 * - A change **begins** by adding its id to `pendingChanges` and bumping `fenceVersion`; it may commit in PostgreSQL
 *   only after that begin is confirmed. The guard candidate
 *   (`infra/aws-clinical-core/source-candidates/workforce-membership-fence-guard.sql`) refuses the change in the
 *   database unless the transaction carries the acknowledgement this module issues.
 * - It **settles** after the database transaction has finished, committed or not: its id leaves the set and the
 *   version moves again.
 * - A write that observed the fence settled at version `v` is held to exactly that state by a `ConditionCheck` in the
 *   write's own `TransactWrite`. So a write either committed before the change began, while the membership it was
 *   admitted under was still current, or it fails. A fence with any change in flight admits nothing.
 *
 * A change that never settles (a crash between begin and settle) leaves its id in the set, and every fenced write for
 * that subject or clinic is refused until an operator settles it. That is the fail-closed direction, on purpose.
 */
export const MEMBERSHIP_FENCE_PROTOCOL = "membership-fence/1";
const FENCE_SORT_KEY = "MEMBERSHIP_FENCE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whose authority a fence covers: one workforce subject (memberships, identity, person) or one clinic (its own row). */
export type MembershipFenceTarget = { kind: "subject"; subject: string } | { kind: "clinic"; organizationId: string };
export type ObservedMembershipFence = { key: { pk: string; sk: string } }
  & ({ state: "absent" } | { state: "settled" | "changing"; version: number });
/** One begun change: what it fenced, and the acknowledgement its database transaction must carry. */
export type MembershipFenceChange = { changeId: string; targets: MembershipFenceTarget[]; acknowledgement: string };
export interface MembershipFenceWriter {
  /** Durably begins one change on every target. If any begin cannot be confirmed, the change must not run. */
  begin(targets: readonly MembershipFenceTarget[]): Promise<MembershipFenceChange>;
  /** Settles a begun change after its transaction has finished. Never throws: an unsettled fence stays closed. */
  settle(change: MembershipFenceChange): Promise<void>;
}
type Send = (command: GetCommand | UpdateCommand) => Promise<unknown>;

export class MembershipFenceError extends Error {
  constructor(readonly category: "membership_fence_invalid" | "membership_fence_unavailable") {
    super(category);
    this.name = "MembershipFenceError";
  }
}

export function membershipFenceTargetName(target: MembershipFenceTarget): string {
  const id = target.kind === "subject" ? target.subject : target.organizationId;
  if (!UUID.test(id)) throw new MembershipFenceError("membership_fence_invalid");
  return `${target.kind}:${id.toLowerCase()}`;
}

export function membershipFenceKey(target: MembershipFenceTarget): { pk: string; sk: string } {
  const [, id] = membershipFenceTargetName(target).split(":");
  return { pk: `${target.kind === "subject" ? "WORKFORCE_SUBJECT" : "CLINIC"}#${id}`, sk: FENCE_SORT_KEY };
}

/** A strongly consistent read of one fence. An item that is not exactly a `membership-fence/1` fence is refused. */
export async function readMembershipFence(send: Send, tableName: string, target: MembershipFenceTarget): Promise<ObservedMembershipFence> {
  const key = membershipFenceKey(target);
  const result = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined;
  return decodeMembershipFence(key, result?.Item);
}

export function decodeMembershipFence(key: { pk: string; sk: string }, item: Record<string, unknown> | undefined): ObservedMembershipFence {
  if (item === undefined) return { key, state: "absent" };
  const pending = item.pendingChanges;
  if (item.pk !== key.pk || item.sk !== key.sk || item.fenceProtocol !== MEMBERSHIP_FENCE_PROTOCOL
    || !Number.isSafeInteger(item.fenceVersion) || (item.fenceVersion as number) < 1
    || (pending !== undefined && (!(pending instanceof Set) || pending.size === 0 || pending.size > 64
      || [...pending].some((id) => typeof id !== "string" || !UUID.test(id))))) {
    throw new MembershipFenceError("membership_fence_invalid");
  }
  return { key, state: pending === undefined ? "settled" : "changing", version: item.fenceVersion as number };
}

/**
 * The `TransactWrite` item that holds a write to the fence it observed: still absent, or still settled at the same
 * version. A changing fence admits nothing, so asking for its condition is a programming error.
 */
export function membershipFenceCondition(tableName: string, observed: ObservedMembershipFence) {
  if (observed.state === "changing") throw new MembershipFenceError("membership_fence_invalid");
  return { ConditionCheck: observed.state === "absent"
    ? { TableName: tableName, Key: observed.key, ConditionExpression: "attribute_not_exists(pk)" }
    : { TableName: tableName, Key: observed.key,
      ConditionExpression: "fenceProtocol = :fenceProtocol AND fenceVersion = :fenceVersion AND attribute_not_exists(pendingChanges)",
      ExpressionAttributeValues: { ":fenceProtocol": MEMBERSHIP_FENCE_PROTOCOL, ":fenceVersion": observed.version } } };
}

/** The writer the membership-changing side uses. It needs `UpdateItem` on the fence items and nothing else. */
export function createMembershipFenceWriter(send: Send, tableName: string): MembershipFenceWriter {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new MembershipFenceError("membership_fence_invalid");
  const update = (target: MembershipFenceTarget, changeId: string, phase: "begin" | "settle") => send(new UpdateCommand({
    TableName: tableName, Key: membershipFenceKey(target),
    ...(phase === "begin" ? {
      UpdateExpression: "SET fenceProtocol = :fenceProtocol, changedAt = :at ADD fenceVersion :one, pendingChanges :change",
      ConditionExpression: "attribute_not_exists(pk) OR fenceProtocol = :fenceProtocol",
    } : {
      UpdateExpression: "SET settledAt = :at ADD fenceVersion :one DELETE pendingChanges :change",
      ConditionExpression: "fenceProtocol = :fenceProtocol AND contains(pendingChanges, :changeId)",
    }),
    ExpressionAttributeValues: { ":fenceProtocol": MEMBERSHIP_FENCE_PROTOCOL, ":at": new Date().toISOString(), ":one": 1,
      ":change": new Set([changeId]), ...(phase === "settle" ? { ":changeId": changeId } : {}) },
  }));
  const settle = async (change: MembershipFenceChange) => {
    for (const target of change.targets) {
      try { await update(target, change.changeId, "settle"); } catch {
        // Fixed label only. The fence stays changing, and fenced writes stay refused, until an operator settles it.
        console.warn(JSON.stringify({ event: "membership_fence_unsettled", protocol: MEMBERSHIP_FENCE_PROTOCOL }));
      }
    }
  };
  return {
    async begin(targets) {
      const names = [...new Set(targets.map(membershipFenceTargetName))];
      if (names.length === 0 || names.length !== targets.length) throw new MembershipFenceError("membership_fence_invalid");
      const changeId = randomUUID();
      const change: MembershipFenceChange = { changeId, targets: [...targets],
        acknowledgement: [MEMBERSHIP_FENCE_PROTOCOL, changeId, ...names].join(" ") };
      for (const target of targets) {
        try { await update(target, change.changeId, "begin"); } catch {
          // An unconfirmed begin may still have landed: settle whatever this change did reach, then refuse the change.
          await settle(change);
          throw new MembershipFenceError("membership_fence_unavailable");
        }
      }
      return change;
    },
    settle,
  };
}
