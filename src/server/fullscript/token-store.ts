if (typeof window !== "undefined") throw new Error("Fullscript token storage is server-only.");

import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { FullscriptToken } from "./client";

export type StoredFullscriptConnection = FullscriptToken & {
  actorKey: string;
  organizationId: string;
  environment: "sandbox_us" | "production_us";
  connectedAt: string;
};

export interface FullscriptTokenStore {
  get(actorKey: string, organizationId: string): Promise<StoredFullscriptConnection | null>;
  put(connection: StoredFullscriptConnection): Promise<void>;
  delete(actorKey: string, organizationId: string): Promise<void>;
  consumeNonce(nonce: string, expiresAt: number): Promise<boolean>;
}

export function createAwsFullscriptTokenStore(env: NodeJS.ProcessEnv = process.env): FullscriptTokenStore | null {
  const tableName = env.FULLSCRIPT_TOKEN_TABLE?.trim() ?? "";
  const region = env.AWS_REGION?.trim() || env.CLINICAL_AWS_REGION?.trim() || "";
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName) || !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) return null;
  const client = new DynamoDBClient({ region });
  const key = (actorKey: string, organizationId: string) => ({
    pk: { S: `ORG#${organizationId}` }, sk: { S: `FULLSCRIPT#${actorKey}` },
  });
  return {
    async get(actorKey, organizationId) {
      const result = await client.send(new GetItemCommand({ TableName: tableName, Key: key(actorKey, organizationId), ConsistentRead: true }));
      if (!result.Item?.payload?.S) return null;
      try { return JSON.parse(result.Item.payload.S) as StoredFullscriptConnection; } catch { return null; }
    },
    async put(connection) {
      await client.send(new PutItemCommand({
        TableName: tableName,
        Item: { ...key(connection.actorKey, connection.organizationId), payload: { S: JSON.stringify(connection) } },
      }));
    },
    async delete(actorKey, organizationId) {
      await client.send(new DeleteItemCommand({ TableName: tableName, Key: key(actorKey, organizationId) }));
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
