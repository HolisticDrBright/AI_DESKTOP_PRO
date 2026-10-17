if (typeof window !== "undefined") throw new Error("Fullscript runtime is server-only.");

import { createHash, randomBytes } from "node:crypto";
import { AdapterError, isAdapterError } from "@/adapters/errors";
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
import {
  createAwsFullscriptGenerationReader,
  createAwsFullscriptRevocationOutbox,
  FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE,
  sameGeneration,
} from "./membership-generation";

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

/** Clinician-safe answers that say only what is known. None names a clinic, account, token or provider error. */
export const FULLSCRIPT_STATUS_UNAVAILABLE = "Fullscript's status couldn't be read right now. Nothing about your connection has changed. Try again in a moment.";
export const FULLSCRIPT_DISCONNECT_UNCONFIRMED = "Fullscript couldn't confirm the disconnect, so your connection is still active. Try again in a moment.";
export const FULLSCRIPT_DISCONNECT_CHANGED = "Your Fullscript connection changed while it was being disconnected. Refresh to see it.";
export const FULLSCRIPT_NOT_CONNECTED = "Connect Fullscript first.";
export const FULLSCRIPT_ACTION_UNAVAILABLE = "Fullscript is unavailable right now. Try again in a moment.";
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

/**
 * Whether this saved connection was made under the membership generation that is current now. If not (a membership
 * removed and re-added, a clinic suspended and reinstated, an identity disabled, or a connection older than generations),
 * it is moved into the revocation outbox and never used again. Without the fence table nothing is used at all.
 */
async function connectionIsCurrent(session: RequestSession, connection: StoredFullscriptConnection, env: NodeJS.ProcessEnv): Promise<boolean> {
  const reader = createAwsFullscriptGenerationReader(env);
  const subject = tokenSubject(session.token);
  if (!reader || !subject || !session.orgId) throw new FullscriptUnavailableError();
  if (sameGeneration(connection.membershipGeneration, await reader.current(subject, session.orgId))) return true;
  try { await createAwsFullscriptRevocationOutbox(env)?.supersede(connection, "membership_changed"); } catch { /* read again next time */ }
  return false;
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
  // Fullscript must confirm the revocation before the row goes: deleting it on a failed revoke would leave a token
  // valid at Fullscript that nothing here could revoke again. So the connection stays, and the answer says so.
  try { await revokeFullscriptToken({ configuration, token: connection.accessToken }); } catch {
    throw new AdapterError("unavailable", FULLSCRIPT_DISCONNECT_UNCONFIRMED, "fullscript_revocation_unconfirmed");
  }
  if (!(await store.delete(connection))) throw new AdapterError("conflict", FULLSCRIPT_DISCONNECT_CHANGED, "fullscript_disconnect_raced");
}

/** A Fullscript failure from a provider action, as the practitioner should read it: a reconnect is asked for in its own
 * words (a 409, with the reason), never a generic "Something went wrong"; anything else is unavailable. */
export function fullscriptActionError(error: unknown): AdapterError {
  if (isAdapterError(error)) return error;
  const message = error instanceof FullscriptUnavailableError ? error.message : "";
  if (message === FULLSCRIPT_RECONNECT_REQUIRED || message === FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE || message === FULLSCRIPT_NOT_CONNECTED) {
    return new AdapterError("conflict", message, "fullscript_reconnect_required");
  }
  return new AdapterError("unavailable", FULLSCRIPT_ACTION_UNAVAILABLE, "fullscript_action_unavailable");
}

/**
 * The Integrations card's status. Three different answers, never confused:
 *   - not configured (this deployment has no Fullscript): `configured: false`, with a reason;
 *   - configured, with what is saved for this account (connected, ready, or a saved connection needing reconnect);
 *   - the status could not be read (a table, fence or generation read failing, a membership change in flight, a
 *     malformed row): a 503 with FULLSCRIPT_STATUS_UNAVAILABLE. Nobody is in a position to say "not configured" then,
 *     and saying it would offer the setup steps to a practitioner whose connection is fine.
 */
export async function fullscriptPosture(session: RequestSession) {
  let configuration: ReturnType<typeof readFullscriptConfiguration>;
  try { configuration = readFullscriptConfiguration(); } catch {
    return { configured: false, connected: false, environment: null, reason: "not_configured" } as const;
  }
  try {
    const store = createAwsFullscriptTokenStore();
    if (!store) return { configured: false, connected: false, environment: configuration.environment, reason: "token_store_missing" } as const;
    const actor = fullscriptActor(session);
    const saved = await store.get(actor.actorKey, actor.organizationId);
    const connection = saved ? parseStoredFullscriptConnection(saved, actor) : null;
    if (connection && connection.environment !== configuration.environment) throw new FullscriptUnavailableError();
    const reconnectReason = connection
      ? (await connectionIsCurrent(session, connection, process.env) ? null : "membership_changed" as const)
      : (await emailKeyedConnectionExists(store, session) ? "account_binding" as const : null);
    if (reconnectReason) {
      return { configured: true, connected: false, reconnectRequired: true, reconnectReason, environment: configuration.environment,
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
    throw new AdapterError("unavailable", FULLSCRIPT_STATUS_UNAVAILABLE, "fullscript_status_unread");
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
  if (!connection || connection.environment !== configuration.environment) throw new FullscriptUnavailableError(FULLSCRIPT_NOT_CONNECTED);
  connection = parseStoredFullscriptConnection(connection, actor);
  // Before any use or refresh: a connection made under authority that has since been reduced is never used again.
  if (!(await connectionIsCurrent(session, connection, env))) throw new FullscriptUnavailableError(FULLSCRIPT_RECONNECT_AFTER_MEMBERSHIP_CHANGE);
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
