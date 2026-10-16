if (typeof window !== "undefined") throw new Error("Fullscript connection admission is server-only.");

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { tokenSubject } from "@/adapters/selected-clinic.server";
import {
  membershipFenceCondition,
  readMembershipFence,
  type ObservedMembershipFence,
} from "@/server/clinical-core/membership-fence";
import type { RequestSession } from "@/server/session";
import { FullscriptUnavailableError } from "./client";
import { parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";

type Send = (command: GetCommand | TransactWriteCommand) => Promise<unknown>;
type Admission = {
  subject: string;
  organizationId: string;
  actorKey: string;
  fences: readonly [ObservedMembershipFence, ObservedMembershipFence];
  previousPayload: string | null;
};

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
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
        if (typeof payload === "string") parseStoredFullscriptConnection(JSON.parse(payload), actor);
        const previousPayload = typeof payload === "string" ? payload : null;
        return { subject, organizationId: actor.organizationId, actorKey: actor.actorKey,
          fences: fences as [ObservedMembershipFence, ObservedMembershipFence], previousPayload };
      } catch { throw new FullscriptUnavailableError(); }
    },

    /** Linearization point: the token Put and both settled-fence version checks are one DynamoDB transaction. */
    async install(connection: StoredFullscriptConnection, admission: Admission): Promise<void> {
      const parsed = parseStoredFullscriptConnection(connection,
        { actorKey: admission.actorKey, organizationId: admission.organizationId });
      if (parsed.organizationId !== admission.organizationId || parsed.actorKey !== admission.actorKey
        || admission.fences.length !== 2) throw new FullscriptUnavailableError();
      try {
        await send(new TransactWriteCommand({ TransactItems: [
          ...admission.fences.map((fence) => membershipFenceCondition(fenceTable, fence)),
          { Put: { TableName: tokenTable,
            Item: { pk: `ORG#${parsed.organizationId}`, sk: `FULLSCRIPT#${parsed.actorKey}`,
              payload: JSON.stringify(parsed) },
            ConditionExpression: admission.previousPayload === null ? "attribute_not_exists(pk)" : "payload = :previous",
            ...(admission.previousPayload === null ? {} : { ExpressionAttributeValues: { ":previous": admission.previousPayload } }),
          } },
        ] }));
      } catch { throw new FullscriptUnavailableError(); }
    },
  };
}
