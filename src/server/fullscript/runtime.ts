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
import { createAwsFullscriptTokenStore, parseStoredFullscriptConnection, type StoredFullscriptConnection } from "./token-store";
import { FULLSCRIPT_DRAFT_SCOPES } from './draft-scopes';

export function fullscriptActor(session: RequestSession): { actorKey: string; organizationId: string } {
  if (!session.signedIn || session.expired || !session.email || !session.orgId) throw new FullscriptUnavailableError("Sign in before connecting Fullscript.");
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
  if (parseStoredFullscriptConnection(connection, actor).environment !== configuration.environment)
    throw new FullscriptUnavailableError();
  await revokeFullscriptToken({ configuration, token: connection.accessToken });
  if (!(await store.delete(connection))) throw new FullscriptUnavailableError();
}

export async function fullscriptPosture(session: RequestSession) {
  try {
    const configuration = readFullscriptConfiguration();
    const store = createAwsFullscriptTokenStore();
    if (!store) return { configured: false, connected: false, environment: configuration.environment, reason: "token_store_missing" } as const;
    const actor = fullscriptActor(session);
    const saved = await store.get(actor.actorKey, actor.organizationId);
    const connection = saved ? parseStoredFullscriptConnection(saved, actor) : null;
    if (connection && connection.environment !== configuration.environment) throw new FullscriptUnavailableError();
    return {
      configured: true,
      connected: Boolean(connection),
      environment: configuration.environment,
      resourceOwnerType: connection?.resourceOwner.type ?? null,
      scopes: connection?.scope ?? [],
      connectedAt: connection?.connectedAt ?? null,
      productionApproved: configuration.environment === "production_us",
    } as const;
  } catch {
    return { configured: false, connected: false, environment: null, reason: "unavailable" } as const;
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

export async function connectedFullscriptClient(session: RequestSession, requireDraftInstallation = false, env: NodeJS.ProcessEnv = process.env): Promise<{
  client: FullscriptApiClient;
  connection: StoredFullscriptConnection;
}> {
  const configuration = readFullscriptConfiguration(env);
  const store = createAwsFullscriptTokenStore(env);
  if (!store) throw new FullscriptUnavailableError();
  const actor = fullscriptActor(session);
  let connection = await store.get(actor.actorKey, actor.organizationId);
  if (!connection || connection.environment !== configuration.environment) throw new FullscriptUnavailableError("Connect Fullscript first.");
  connection = parseStoredFullscriptConnection(connection, actor);
  // Validate the saved OAuth client BEFORE a refresh transmits its credential.
  // Legacy lookup remains supported, but draft use cannot upgrade a legacy or
  // staff installation merely by renewing its token.
  if ((connection.oauthClientId && connection.oauthClientId !== configuration.clientId)
    || (connection.oauthRedirectUri && connection.oauthRedirectUri !== configuration.redirectUri)
    || (requireDraftInstallation && (connection.environment !== 'sandbox_us'
      || !connection.installationId || !connection.oauthClientId || !connection.oauthRedirectUri
      || connection.resourceOwner.type !== 'Practitioner'
      || FULLSCRIPT_DRAFT_SCOPES.some(scope => !connection!.scope.includes(scope))))) {
    throw new FullscriptUnavailableError();
  }
  if (Date.parse(connection.expiresAt) - 60_000 <= Date.now()) {
    const refreshed: FullscriptToken = await refreshFullscriptToken({ configuration, refreshToken: connection.refreshToken });
    const replacement = parseStoredFullscriptConnection({ ...connection, ...refreshed }, actor);
    // A refresh is credential rotation, not permission to switch identity or
    // silently expand/reduce the reviewed installation's permissions. Require
    // explicit reauthorization/review instead; never overwrite the old binding.
    if (replacement.resourceOwner.id !== connection.resourceOwner.id
      || replacement.resourceOwner.type !== connection.resourceOwner.type
      || replacement.scope.length !== connection.scope.length
      || replacement.scope.some(scope => !connection!.scope.includes(scope))
      || Date.parse(replacement.expiresAt) - 60_000 <= Date.now()) {
      throw new FullscriptUnavailableError();
    }
    if (!(await store.replace(connection, replacement))) throw new FullscriptUnavailableError();
    connection = replacement;
  }
  return { client: new FullscriptApiClient(configuration, connection.accessToken, fetch, connection.scope), connection };
}
