import { NextRequest, NextResponse } from "next/server";
import { exchangeFullscriptAuthorizationCode, fullscriptIntegrationReturnUrl, readFullscriptConfiguration, verifyFullscriptState } from "@/server/fullscript/client";
import { createAwsFullscriptTokenStore } from "@/server/fullscript/token-store";

export async function GET(request: NextRequest) {
  const target = fullscriptIntegrationReturnUrl(request.url);
  try {
    const code = request.nextUrl.searchParams.get("code") ?? "";
    const state = request.nextUrl.searchParams.get("state") ?? "";
    const configuration = readFullscriptConfiguration();
    const verified = verifyFullscriptState(state, configuration.stateSecret);
    const store = createAwsFullscriptTokenStore();
    if (!store || !(await store.consumeNonce(verified.nonce, Date.now() + 600_000))) throw new Error("oauth_replay_refused");
    const token = await exchangeFullscriptAuthorizationCode({ configuration, code });
    await store.put({
      ...token,
      actorKey: verified.actorKey,
      organizationId: verified.organizationId,
      environment: configuration.environment,
      connectedAt: new Date().toISOString(),
    });
    target.searchParams.set("fullscript", "connected");
  } catch {
    target.searchParams.set("fullscript", "connection_failed");
  }
  return NextResponse.redirect(target, { status: 303 });
}
