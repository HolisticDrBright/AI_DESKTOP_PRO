if (typeof window !== "undefined") throw new Error("Fullscript runtime is server-only.");

import { createHash, randomBytes } from "node:crypto";
import type { RequestSession } from "@/server/session";
import {
  createFullscriptAuthorization,
  FullscriptApiClient,
  FullscriptUnavailableError,
  readFullscriptConfiguration,
  refreshFullscriptToken,
  revokeFullscriptToken,
  type FullscriptToken,
} from "./client";
import { createAwsFullscriptTokenStore, type StoredFullscriptConnection } from "./token-store";

export function fullscriptActor(session: RequestSession): { actorKey: string; organizationId: string } {
  if (!session.signedIn || !session.email || !session.orgId) throw new FullscriptUnavailableError("Sign in before connecting Fullscript.");
  return {
    actorKey: createHash("sha256").update(`${session.orgId}\u0000${session.email.toLowerCase()}`).digest("hex"),
    organizationId: session.orgId,
  };
}

export async function disconnectFullscript(session: RequestSession): Promise<void> {
  const configuration = readFullscriptConfiguration();
  const store = createAwsFullscriptTokenStore();
  if (!store) throw new FullscriptUnavailableError();
  const actor = fullscriptActor(session);
  const connection = await store.get(actor.actorKey, actor.organizationId);
  if (!connection) return;
  await revokeFullscriptToken({ configuration, token: connection.accessToken });
  await store.delete(actor.actorKey, actor.organizationId);
}

export async function fullscriptPosture(session: RequestSession) {
  try {
    const configuration = readFullscriptConfiguration();
    const store = createAwsFullscriptTokenStore();
    if (!store) return { configured: false, connected: false, environment: configuration.environment, reason: "token_store_missing" } as const;
    const actor = fullscriptActor(session);
    const connection = await store.get(actor.actorKey, actor.organizationId);
    return {
      configured: true,
      connected: Boolean(connection),
      environment: configuration.environment,
      resourceOwnerType: connection?.resourceOwner.type ?? null,
      scopes: connection?.scope ?? [],
      connectedAt: connection?.connectedAt ?? null,
      productionApproved: configuration.environment === "production_us",
    } as const;
  } catch (error) {
    return { configured: false, connected: false, environment: null, reason: error instanceof Error ? error.message : "unavailable" } as const;
  }
}

export function beginFullscriptAuthorization(session: RequestSession) {
  const configuration = readFullscriptConfiguration();
  if (!createAwsFullscriptTokenStore()) throw new FullscriptUnavailableError("Fullscript token storage is not configured.");
  const actor = fullscriptActor(session);
  return createFullscriptAuthorization({
    configuration,
    ...actor,
    nonce: randomBytes(24).toString("base64url"),
  });
}

export async function connectedFullscriptClient(session: RequestSession): Promise<{
  client: FullscriptApiClient;
  connection: StoredFullscriptConnection;
}> {
  const configuration = readFullscriptConfiguration();
  const store = createAwsFullscriptTokenStore();
  if (!store) throw new FullscriptUnavailableError();
  const actor = fullscriptActor(session);
  let connection = await store.get(actor.actorKey, actor.organizationId);
  if (!connection || connection.environment !== configuration.environment) throw new FullscriptUnavailableError("Connect Fullscript first.");
  if (Date.parse(connection.expiresAt) - 60_000 <= Date.now()) {
    const refreshed: FullscriptToken = await refreshFullscriptToken({ configuration, refreshToken: connection.refreshToken });
    connection = { ...connection, ...refreshed };
    await store.put(connection);
  }
  return { client: new FullscriptApiClient(configuration, connection.accessToken), connection };
}
