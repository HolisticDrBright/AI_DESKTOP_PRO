if (typeof window !== "undefined") throw new Error("Fullscript token storage is server-only.");

import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { FullscriptUnavailableError, type FullscriptToken } from "./client";

export type StoredFullscriptConnection = FullscriptToken & {
  actorKey: string;
  organizationId: string;
  environment: "sandbox_us" | "production_us";
  connectedAt: string;
  /** New authorization, not a token refresh. Legacy records remain readable
   * for lookup but cannot be approved for governed draft delivery. */
  installationId?: string;
  oauthClientId?: string;
  oauthRedirectUri?: string;
};

const tokenKey = z.object({
  actorKey: z.string().regex(/^[a-f0-9]{64}$/),
  organizationId: z.string().uuid(),
}).strict();
const storedConnection = tokenKey.extend({
  accessToken: z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/),
  refreshToken: z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/),
  expiresAt: z.string().datetime(),
  scope: z.array(z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/).max(100)).max(64)
    .refine(scopes => new Set(scopes).size === scopes.length),
  resourceOwner: z.object({
    id: z.string().regex(/^[A-Za-z0-9-]{16,128}$/),
    type: z.enum(["Practitioner", "Staff"]),
  }).strict(),
  environment: z.enum(["sandbox_us", "production_us"]),
  connectedAt: z.string().datetime(),
  installationId: z.string().uuid().optional(),
  oauthClientId: z.string().regex(/^[A-Za-z0-9._~-]{16,512}$/).optional(),
  oauthRedirectUri: z.string().url().refine(value=>{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash
      &&url.pathname==='/api/live/fullscript/oauth/callback';
  }).optional(),
}).strict();

/** A DynamoDB key does not prove the JSON payload belongs to that account.
 * Validate both on every read/write; malformed custody is a refusal, not a
 * successful disconnected status. No token or provider error is exposed. */
export function parseStoredFullscriptConnection(value: unknown, expected?: {
  actorKey: string; organizationId: string;
}): StoredFullscriptConnection {
  try {
    const parsed = storedConnection.parse(value);
    if (expected) {
      const key = tokenKey.parse(expected);
      if (parsed.actorKey !== key.actorKey || parsed.organizationId !== key.organizationId)
        throw new FullscriptUnavailableError();
    }
    return parsed;
  } catch { throw new FullscriptUnavailableError(); }
}

export interface FullscriptTokenStore {
  get(actorKey: string, organizationId: string): Promise<StoredFullscriptConnection | null>;
  put(connection: StoredFullscriptConnection): Promise<void>;
  replace(previous: StoredFullscriptConnection, replacement: StoredFullscriptConnection): Promise<boolean>;
  delete(previous: StoredFullscriptConnection): Promise<boolean>;
  consumeNonce(nonce: string, expiresAt: number): Promise<boolean>;
}

export function createAwsFullscriptTokenStore(env: NodeJS.ProcessEnv = process.env): FullscriptTokenStore | null {
  const tableName = env.FULLSCRIPT_TOKEN_TABLE?.trim() ?? "";
  const region = env.AWS_REGION?.trim() || env.CLINICAL_AWS_REGION?.trim() || "";
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) return null;
  const client = new DynamoDBClient({ region });
  const key = (actorKey: string, organizationId: string) => {
    if (!tokenKey.safeParse({actorKey, organizationId}).success) throw new FullscriptUnavailableError();
    return {pk: { S: `ORG#${organizationId}` }, sk: { S: `FULLSCRIPT#${actorKey}` }};
  };
  return {
    async get(actorKey, organizationId) {
      const result = await client.send(new GetItemCommand({ TableName: tableName, Key: key(actorKey, organizationId), ConsistentRead: true }));
      if (!result.Item) return null;
      try {
        if (typeof result.Item.payload?.S !== "string") throw new FullscriptUnavailableError();
        return parseStoredFullscriptConnection(JSON.parse(result.Item.payload.S), {actorKey, organizationId});
      } catch { throw new FullscriptUnavailableError(); }
    },
    async put(connection) {
      const parsed = parseStoredFullscriptConnection(connection);
      await client.send(new PutItemCommand({
        TableName: tableName,
        Item: { ...key(parsed.actorKey, parsed.organizationId), payload: { S: JSON.stringify(parsed) } },
      }));
    },
    async replace(previous, replacement) {
      const before = parseStoredFullscriptConnection(previous);
      const expectedKey = {actorKey: before.actorKey, organizationId: before.organizationId};
      const after = parseStoredFullscriptConnection(replacement, expectedKey);
      if (after.environment !== before.environment || after.connectedAt !== before.connectedAt
        || after.installationId !== before.installationId
        || after.oauthClientId !== before.oauthClientId || after.oauthRedirectUri !== before.oauthRedirectUri
        || after.resourceOwner.id !== before.resourceOwner.id || after.resourceOwner.type !== before.resourceOwner.type
        || after.scope.length !== before.scope.length || after.scope.some(scope => !before.scope.includes(scope))) {
        throw new FullscriptUnavailableError();
      }
      const Key = key(before.actorKey, before.organizationId);
      // Use the exact stored bytes in the conditional write, not reserialized
      // JSON (older OAuth records may have a different property order).
      const current = await client.send(new GetItemCommand({TableName: tableName, Key, ConsistentRead: true}));
      if (!current.Item) return false; // A disconnect is never resurrected.
      let raw: string;
      try {
        if (typeof current.Item.payload?.S !== "string") throw new FullscriptUnavailableError();
        raw = current.Item.payload.S;
        const observed = parseStoredFullscriptConnection(JSON.parse(raw), expectedKey);
        if (JSON.stringify(observed) !== JSON.stringify(before)) return false;
      } catch { throw new FullscriptUnavailableError(); }
      try {
        await client.send(new PutItemCommand({TableName: tableName,
          Item: {...Key, payload: {S: JSON.stringify(after)}},
          ConditionExpression: "attribute_exists(pk) AND payload = :previous",
          ExpressionAttributeValues: {":previous": {S: raw}},
        }));
        return true;
      } catch (error) {
        if ((error as {name?: string}).name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async delete(previous) {
      const before = parseStoredFullscriptConnection(previous);
      const expectedKey = {actorKey: before.actorKey, organizationId: before.organizationId};
      const Key = key(before.actorKey, before.organizationId);
      const current = await client.send(new GetItemCommand({TableName: tableName, Key, ConsistentRead: true}));
      if (!current.Item) return true; // Already absent; no new installation is deleted.
      let raw: string;
      try {
        if (typeof current.Item.payload?.S !== "string") throw new FullscriptUnavailableError();
        raw = current.Item.payload.S;
        if (JSON.stringify(parseStoredFullscriptConnection(JSON.parse(raw), expectedKey)) !== JSON.stringify(before)) return false;
      } catch { throw new FullscriptUnavailableError(); }
      try {
        await client.send(new DeleteItemCommand({TableName: tableName, Key,
          ConditionExpression: "payload = :previous", ExpressionAttributeValues: {":previous": {S: raw}},
        }));
        return true;
      } catch (error) {
        if ((error as {name?: string}).name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async consumeNonce(nonce, expiresAt) {
      try {
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: { S: "OAUTH_NONCE" }, sk: { S: nonce },
            ttl: { N: String(Math.ceil(expiresAt / 1000)) },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }));
        return true;
      } catch (error) {
        if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
  };
}
