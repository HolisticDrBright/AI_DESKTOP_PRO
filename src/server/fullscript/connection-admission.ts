if (typeof window !== "undefined") throw new Error("Fullscript connection admission is server-only.");

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { tokenSubject } from "@/adapters/selected-clinic.server";
import {
  membershipFenceCondition,
  readMembershipFence,
  type ObservedMembershipFence,
} from "@/server/clinical-core/membership-fence";
import type { RequestSession } from "@/server/session";
import { FullscriptUnavailableError } from "./client";
import { parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";
import { generationFromFences, revocationOutboxItem, revocationOutboxKey, sameGeneration } from "./membership-generation";
import {
  FullscriptInstallUnconfirmedError, FullscriptPractitionerConnectedElsewhereError, RESERVE_CONDITION, reservationFor, tokenRowKeyOf,
} from "./practitioner-reservation";

type Send = (command: GetCommand | TransactWriteCommand) => Promise<unknown>;
type Admission = {
  subject: string;
  organizationId: string;
  actorKey: string;
  fences: readonly [ObservedMembershipFence, ObservedMembershipFence];
  previousPayload: string | null;
  /** Whether the saved connection was made under the generation these fences hold: a live connection. Null with none. */
  previousCurrent: boolean | null;
};

/**
 * This account already holds a live Fullscript connection in this clinic. A new authorization never replaces it
 * silently: the replaced token would stay valid at Fullscript with no row left to revoke it from, and a different
 * Fullscript account would take over without anyone choosing that. The practitioner disconnects first, which revokes it.
 */
export class FullscriptAlreadyConnectedError extends FullscriptUnavailableError {
  constructor() {
    super("This account already has a Fullscript connection in this clinic.");
    this.name = "FullscriptAlreadyConnectedError";
  }
}

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const DEFINITE_REFUSALS = new Set(["ValidationException", "AccessDeniedException", "ResourceNotFoundException", "TransactionConflictException",
  "ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "IdempotentParameterMismatchException"]);
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/**
 * Admission for a new OAuth installation, not for reading or renewing an existing token.
 * The database guard must make every authority-reducing change begin its membership fence before commit.
 * If that guard, its change writer, this table permission and this code are not released together, keep Fullscript
 * connection disabled. Missing configuration refuses rather than falling back to the former unfenced PutItem.
 */
export function createAwsFullscriptConnectionAdmission(
  env: NodeJS.ProcessEnv = process.env,
  suppliedSend?: Send,
) {
  const tokenTable = env.FULLSCRIPT_TOKEN_TABLE?.trim() ?? "";
  const fenceTable = env.FULLSCRIPT_MEMBERSHIP_FENCE_TABLE?.trim() ?? "";
  const region = env.AWS_REGION?.trim() || env.CLINICAL_AWS_REGION?.trim() || "";
  if (!TABLE_NAME.test(tokenTable) || !TABLE_NAME.test(fenceTable) || !REGION.test(region)
    || tokenTable === "disabled" || fenceTable === "disabled") return null;
  const client = suppliedSend ? null : DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const send: Send = suppliedSend ?? ((command) => client!.send(command as never));

  return {
    /** Observe both fences before the final, current-membership read in the callback. */
    async observe(session: RequestSession, actor: { actorKey: string; organizationId: string }): Promise<Admission> {
      const subject = tokenSubject(session.token);
      if (!subject || !session.orgId || session.orgId !== actor.organizationId
        || !/^[a-f0-9]{64}$/.test(actor.actorKey)) throw new FullscriptUnavailableError();
      try {
        const fences = await Promise.all([
          readMembershipFence((command) => send(command as GetCommand), fenceTable, { kind: "subject", subject }),
          readMembershipFence((command) => send(command as GetCommand), fenceTable, { kind: "clinic", organizationId: actor.organizationId }),
        ]);
        if (fences.some((fence) => fence.state === "changing")) throw new FullscriptUnavailableError();
        const key = { pk: `ORG#${actor.organizationId}`, sk: `FULLSCRIPT#${actor.actorKey}` };
        const previous = await send(new GetCommand({ TableName: tokenTable, Key: key, ConsistentRead: true })) as
          { Item?: Record<string, unknown> } | undefined;
        const payload = previous?.Item?.payload;
        if (previous?.Item && (previous.Item.pk !== key.pk || previous.Item.sk !== key.sk || typeof payload !== "string"))
          throw new FullscriptUnavailableError();
        const observed = fences as [ObservedMembershipFence, ObservedMembershipFence];
        const previousCurrent = typeof payload === "string"
          ? sameGeneration(parseStoredFullscriptConnection(JSON.parse(payload), actor).membershipGeneration, generationFromFences(observed))
          : null;
        const previousPayload = typeof payload === "string" ? payload : null;
        return { subject, organizationId: actor.organizationId, actorKey: actor.actorKey, fences: observed, previousPayload, previousCurrent };
      } catch { throw new FullscriptUnavailableError(); }
    },

    /**
     * Linearization point: the token Put, the practitioner's ownership reservation and both settled-fence version checks
     * are one DynamoDB transaction.
     *
     * Over a saved connection:
     *   - a live one (made under the current generation) is never replaced: FullscriptAlreadyConnectedError;
     *   - a superseded one (made under an earlier generation, or before generations) is moved into the revocation
     *     outbox in the same transaction, exactly as a read would move it, so its token is queued for revocation
     *     rather than overwritten and forgotten.
     *
     * The Fullscript practitioner the token names may be connected to one Desktop account only
     * (practitioner-reservation.ts): a reservation held by another account cancels the whole transaction, so this
     * account's token is never saved and the other connection is untouched (FullscriptPractitionerConnectedElsewhereError).
     *
     * A reply lost in transit is retried once with the same client request token, which DynamoDB applies at most once.
     * If that is not conclusive either, the row is read back: this exact installation saved is a success, anything else
     * is FullscriptInstallUnconfirmedError, never a guess.
     */
    async install(connection: StoredFullscriptConnection, admission: Admission): Promise<void> {
      const parsed = parseStoredFullscriptConnection(connection,
        { actorKey: admission.actorKey, organizationId: admission.organizationId });
      if (parsed.organizationId !== admission.organizationId || parsed.actorKey !== admission.actorKey
        || admission.fences.length !== 2) throw new FullscriptUnavailableError();
      if (admission.previousPayload !== null && admission.previousCurrent !== false) throw new FullscriptAlreadyConnectedError();
      // The generation this installation is admitted under: exactly the fence versions the transaction below holds.
      const stored = { ...parsed, membershipGeneration: generationFromFences(admission.fences) };
      const key = tokenRowKeyOf(parsed);
      const at = new Date().toISOString();
      let superseded: NonNullable<TransactWriteCommandInput["TransactItems"]>[number] | null = null;
      if (admission.previousPayload !== null) {
        const previous = parseStoredFullscriptConnection(JSON.parse(admission.previousPayload),
          { actorKey: admission.actorKey, organizationId: admission.organizationId });
        superseded = { Put: { TableName: tokenTable, ConditionExpression: "attribute_not_exists(pk)",
          Item: revocationOutboxItem(revocationOutboxKey(previous), "membership_changed", admission.previousPayload, at) } };
      }
      const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
        ...admission.fences.map((fence) => membershipFenceCondition(fenceTable, fence)),
        ...(superseded ? [superseded] : []),
        { Put: { TableName: tokenTable, Item: reservationFor(stored, at), ConditionExpression: RESERVE_CONDITION,
          ExpressionAttributeValues: { ":ownerPk": key.pk, ":ownerSk": key.sk } } },
        { Put: { TableName: tokenTable,
          Item: { ...key, payload: JSON.stringify(stored) },
          ConditionExpression: admission.previousPayload === null ? "attribute_not_exists(pk)" : "payload = :previous",
          ...(admission.previousPayload === null ? {} : { ExpressionAttributeValues: { ":previous": admission.previousPayload } }),
        } },
      ];
      const reservationIndex = items.length - 2, rowIndex = items.length - 1;
      /**
       * A cancellation, or a request DynamoDB refused outright, is definite: nothing was written. A cancellation's
       * reasons say which condition refused. Anything else (a timeout, a dropped connection, a server error, a
       * transaction still in progress) may have committed.
       */
      const refusal = (error: unknown): Error | null => {
        const name = (error as { name?: unknown } | null)?.name;
        if (typeof name === "string" && DEFINITE_REFUSALS.has(name)) return new FullscriptUnavailableError();
        if (name !== "TransactionCanceledException") return null;
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons[reservationIndex]?.Code === "ConditionalCheckFailed") return new FullscriptPractitionerConnectedElsewhereError();
        if (reasons[rowIndex]?.Code === "ConditionalCheckFailed") return new FullscriptAlreadyConnectedError();
        return new FullscriptUnavailableError();
      };
      const command = new TransactWriteCommand({ ClientRequestToken: stored.installationId ?? randomUUID(), TransactItems: items });
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await send(command); return; } catch (error) {
          const definite = refusal(error);
          if (definite) throw definite;
        }
      }
      let saved: Record<string, unknown> | undefined;
      try { saved = (await send(new GetCommand({ TableName: tokenTable, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> } | undefined)?.Item; }
      catch { throw new FullscriptInstallUnconfirmedError(); }
      if (saved?.payload === JSON.stringify(stored)) return;
      throw new FullscriptInstallUnconfirmedError();
    },
  };
}
