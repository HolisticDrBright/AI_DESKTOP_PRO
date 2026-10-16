import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { exchangeFullscriptAuthorizationCode, fullscriptIntegrationReturnUrl, FullscriptUnavailableError, readFullscriptConfiguration, verifyFullscriptState } from "@/server/fullscript/client";
import { createAwsFullscriptTokenStore } from "@/server/fullscript/token-store";
import { currentFullscriptSession } from "@/server/fullscript/clinic-authority";
import { fullscriptActor } from "@/server/fullscript/runtime";
import { getRequestSession } from "@/server/session";

/**
 * The signed state proves this server started the authorization; it does not prove that the browser completing it is
 * the account that started it. So the callback completes only in a session of the same account and clinic, still a
 * current member there, checked before the nonce is spent or the code is exchanged. Otherwise a link started by one
 * account and opened in another's browser would save the second person's Fullscript authorization under the first.
 */
export async function GET(request: NextRequest) {
  const target = fullscriptIntegrationReturnUrl(request.url);
  try {
    const code = request.nextUrl.searchParams.get("code") ?? "";
    const state = request.nextUrl.searchParams.get("state") ?? "";
    const configuration = readFullscriptConfiguration();
    const verified = verifyFullscriptState(state, configuration.stateSecret);
    const actor = fullscriptActor(await currentFullscriptSession(await getRequestSession()));
    if (actor.actorKey !== verified.actorKey || actor.organizationId !== verified.organizationId) throw new Error("oauth_session_mismatch");
    const store = createAwsFullscriptTokenStore();
    if (!store || !(await store.consumeNonce(verified.nonce, Date.now() + 600_000))) throw new Error("oauth_replay_refused");
    const token = await exchangeFullscriptAuthorizationCode({ configuration, code });
    await store.put({
      ...token,
      actorKey: verified.actorKey,
      organizationId: verified.organizationId,
      environment: configuration.environment,
      connectedAt: new Date().toISOString(),
      installationId: randomUUID(),
      oauthClientId: configuration.clientId,
      oauthRedirectUri: configuration.redirectUri,
    });
    target.searchParams.set("fullscript", "connected");
  } catch (error) {
    console.error("[fullscript.oauth.callback] authorization failed", {
      category: error instanceof FullscriptUnavailableError ? error.code : "unexpected",
    });
    target.searchParams.set("fullscript", "connection_failed");
  }
  return NextResponse.redirect(target, { status: 303 });
}
