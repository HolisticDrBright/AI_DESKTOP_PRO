if (typeof window !== "undefined") throw new Error("Fullscript runtime is server-only.");

import { createHash, randomBytes } from "node:crypto";
import { tokenSubject } from "@/adapters/selected-clinic.server";
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
import { createAwsFullscriptConnectionAdmission } from "./connection-admission";
import { FULLSCRIPT_DRAFT_SCOPES } from './draft-scopes';

/**
 * The key a practitioner's saved connection is stored under: the clinic and the workforce account (the ID token's
 * Cognito subject). It was the clinic and the lower-case email, so two accounts carrying the same verified address in
 * the same clinic (a re-created account, an alias, a second sign-in method) shared one row and each could read, use,
 * refresh and revoke the other's Fullscript authorization. The label makes the derivation versioned: no subject key
 * can equal an email key.
 */
export function fullscriptActor(session: RequestSession): { actorKey: string; organizationId: string } {
  if (!session.signedIn || session.expired || !session.email || !session.orgId) throw new FullscriptUnavailableError("Sign in before connecting Fullscript.");
  const subject = tokenSubject(session.token);
  if (!subject) throw new FullscriptUnavailableError("Sign in before connecting Fullscript.");
  return {
    actorKey: createHash("sha256").update(`fullscript-actor/2\u0000${session.orgId}\u0000${subject}`).digest("hex"),
    organizationId: session.orgId,
  };
}

export const FULLSCRIPT_RECONNECT_REQUIRED = "Reconnect Fullscript: the earlier connection was saved before connections were tied to your account, so it isn't used.";

/**
 * Whether a connection saved under the older email key exists for this clinic and address. It is never claimed by any
 * account: it is not read for use, refreshed, revoked or deleted here, because nothing in it says which account made
 * it. The account is told to reconnect, which installs a new connection under its own key; the old row is left for a
 * reviewed operator migration that reconciles it with Fullscript (docs/fullscript-subject-binding-2026-10-16.md).
 */
async function emailKeyedConnectionExists(store: NonNullable<ReturnType<typeof createAwsFullscriptTokenStore>>, session: RequestSession) {
  if (!session.email || !session.orgId) return false;
  const actorKey = createHash("sha256").update(`${session.orgId}\u0000${session.email.toLowerCase()}`).digest("hex");
  return (await store.get(actorKey, session.orgId)) !== null;
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
    if (!connection && await emailKeyedConnectionExists(store, session)) {
      return { configured: true, connected: false, reconnectRequired: true, environment: configuration.environment,
        resourceOwnerType: null, scopes: [], connectedAt: null, productionApproved: configuration.environment === "production_us" } as const;
    }
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
  if (!createAwsFullscriptTokenStore() || !createAwsFullscriptConnectionAdmission())
    throw new FullscriptUnavailableError("Fullscript connection is not configured.");
  const actor = fullscriptActor(session);
  const subject = tokenSubject(session.token);
  if (!subject) throw new FullscriptUnavailableError();
  return createFullscriptAuthorization({
    configuration,
    ...actor,
    subject,
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
  if (!connection && await emailKeyedConnectionExists(store, session)) throw new FullscriptUnavailableError(FULLSCRIPT_RECONNECT_REQUIRED);
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
