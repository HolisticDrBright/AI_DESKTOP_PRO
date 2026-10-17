import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { tokenSubject } from "@/adapters/selected-clinic.server";
import { isAdapterError } from "@/adapters/errors";
import { exchangeFullscriptAuthorizationCode, fullscriptIntegrationReturnUrl, FullscriptGrantRefusedError, FullscriptUnavailableError, readFullscriptConfiguration, revokeFullscriptToken, verifyFullscriptState } from "@/server/fullscript/client";
import { createAwsFullscriptTokenStore } from "@/server/fullscript/token-store";
import { currentFullscriptSession } from "@/server/fullscript/clinic-authority";
import { createAwsFullscriptConnectionAdmission } from "@/server/fullscript/connection-admission";
import { createAwsFullscriptRevocationOutbox, type FullscriptRevocationReason } from "@/server/fullscript/membership-generation";
import { fullscriptActor } from "@/server/fullscript/runtime";
import type { StoredFullscriptConnection } from "@/server/fullscript/token-store";
import { getRequestSession } from "@/server/session";
import type { FullscriptCallbackOutcome } from "@/lib/fullscript-presentation";

/**
 * The signed state proves this server started the authorization; it does not prove that the browser completing it is
 * the account that started it. So the callback completes only in a session of the same account and clinic, still a
 * current member there, checked before the nonce is spent or the code is exchanged. Otherwise a link started by one
 * account and opened in another's browser would save the second person's Fullscript authorization under the first.
 *
 * The practitioner is told which of a closed set of outcomes happened, and each is true: a link already used is not
 * "Fullscript refused you", an outage is not "check your account", and a second connection over a live one is refused
 * before any code is exchanged, so nothing is replaced and no token is left behind.
 *
 * Which Fullscript practitioner a token belongs to is known only once the code is exchanged, so a practitioner already
 * connected to another Desktop account is refused by the install itself (`practitioner_connected_elsewhere`). Then a
 * token exists that nothing saved. It is queued in the revocation outbox BEFORE it is revoked: a failed revocation
 * leaves a pending item for the reconciler, never an orphan. Only if the outbox write itself fails is the revocation
 * best effort, and that is logged (without the token) as the one remaining way to orphan it.
 */
type IssuedReason = Extract<FullscriptRevocationReason, "install_refused" | "practitioner_connected_elsewhere" | "install_unconfirmed">;
type RevocationOutbox = NonNullable<ReturnType<typeof createAwsFullscriptRevocationOutbox>>;
async function queueIssued(installation: StoredFullscriptConnection, reason: IssuedReason, revokeNow: (token: string) => Promise<void>) {
  let outbox: RevocationOutbox | null = null;
  let item: Awaited<ReturnType<RevocationOutbox["queue"]>> | null = null;
  // Recording it can fail in any way; that never changes what the practitioner is told, only what is logged.
  try { outbox = createAwsFullscriptRevocationOutbox(); item = outbox ? await outbox.queue(installation, reason) : null; } catch { item = null; }
  // A lost install reply may still have saved this token: the reconciler revokes it only if no saved connection holds it.
  if (reason === "install_unconfirmed") {
    if (!item) console.error("[fullscript.oauth.callback] issued token not queued", { reason });
    return;
  }
  try {
    await revokeNow(installation.accessToken);
    if (item) { try { await outbox!.discard(item); } catch { /* left pending: the reconciler asks Fullscript again */ } } // revoked: nothing left to retry
  } catch {
    // Revocation unconfirmed: the pending item is the reconciler's. With no item, nothing records this token.
    if (!item) console.error("[fullscript.oauth.callback] issued token neither queued nor revoked", { reason });
  }
}
class Outcome extends Error {
  constructor(readonly outcome: Exclude<FullscriptCallbackOutcome, "connected">) { super(outcome); }
}
/** The clinic gate, read as an outcome: an outage is unavailable; anything else means this session can no longer do it. */
const gate = (session: Parameters<typeof currentFullscriptSession>[0]) => currentFullscriptSession(session).catch((error: unknown) => {
  throw new Outcome(isAdapterError(error) && error.code === "unavailable" ? "unavailable" : "session_changed");
});

export async function GET(request: NextRequest) {
  const target = fullscriptIntegrationReturnUrl(request.url);
  try {
    // Fullscript sends the practitioner back with `error` (for example access_denied) when they decline or it refuses.
    if (request.nextUrl.searchParams.has("error")) throw new Outcome("not_authorized");
    const code = request.nextUrl.searchParams.get("code") ?? "";
    const state = request.nextUrl.searchParams.get("state") ?? "";
    const configuration = readFullscriptConfiguration();
    let verified: ReturnType<typeof verifyFullscriptState>;
    try { verified = verifyFullscriptState(state, configuration.stateSecret); } catch { throw new Outcome("link_used"); }
    const session = await gate(await getRequestSession());
    const actor = fullscriptActor(session);
    if (actor.actorKey !== verified.actorKey || actor.organizationId !== verified.organizationId
      || tokenSubject(session.token) !== verified.subject) throw new Outcome("session_changed");
    const store = createAwsFullscriptTokenStore();
    const admissionStore = createAwsFullscriptConnectionAdmission();
    if (!store || !admissionStore) throw new FullscriptUnavailableError();
    const admission = await admissionStore.observe(session, actor);
    // A live connection is never replaced. Refused here, before the nonce is spent or the code exchanged: nothing is
    // issued, so nothing has to be revoked. (The install refuses it again, inside its transaction.)
    if (admission.previousCurrent === true) throw new Outcome("already_connected");
    // The fence is observed before this current-membership read. A change beginning after the read is caught by
    // the transaction that installs the token, even when it begins during the external code exchange.
    await gate(session);
    if (!(await store.consumeNonce(verified.nonce, Date.now() + 600_000))) throw new Outcome("link_used");
    const token = await exchangeFullscriptAuthorizationCode({ configuration, code }).catch((error: unknown) => {
      throw error instanceof FullscriptGrantRefusedError ? new Outcome("not_authorized") : error;
    });
    const installation: StoredFullscriptConnection = {
      ...token,
      actorKey: verified.actorKey,
      organizationId: verified.organizationId,
      environment: configuration.environment,
      connectedAt: new Date().toISOString(),
      installationId: randomUUID(),
      oauthClientId: configuration.clientId,
      oauthRedirectUri: configuration.redirectUri,
    };
    try {
      await admissionStore.install(installation, admission);
    } catch (error) {
      // The provider already issued a token. It is never retained when our authority-fenced install refuses it.
      // Each refusal is matched by name (connection-admission.ts, practitioner-reservation.ts).
      const name = (error as { name?: unknown } | null)?.name;
      const revokeNow = (accessToken: string) => revokeFullscriptToken({ configuration, token: accessToken });
      if (name === "FullscriptInstallUnconfirmedError") {
        await queueIssued(installation, "install_unconfirmed", revokeNow);
        throw new Outcome("unconfirmed");
      }
      await queueIssued(installation, name === "FullscriptPractitionerConnectedElsewhereError" ? "practitioner_connected_elsewhere" : "install_refused", revokeNow);
      if (name === "FullscriptAlreadyConnectedError") throw new Outcome("already_connected");
      if (name === "FullscriptPractitionerConnectedElsewhereError") throw new Outcome("practitioner_connected_elsewhere");
      // A fence that moved during the exchange is usually this account's own access changing: say so if it did.
      await gate(session);
      throw error;
    }
    target.searchParams.set("fullscript", "connected");
  } catch (error) {
    const outcome = error instanceof Outcome ? error.outcome : "unavailable";
    console.error("[fullscript.oauth.callback] authorization failed", {
      outcome, category: error instanceof FullscriptUnavailableError ? error.code : error instanceof Outcome ? "refused" : "unexpected",
    });
    target.searchParams.set("fullscript", outcome);
  }
  return NextResponse.redirect(target, { status: 303 });
}
