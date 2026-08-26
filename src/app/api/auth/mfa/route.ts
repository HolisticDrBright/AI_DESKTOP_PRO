import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AUTH_COOKIES,
  completeMfaSignIn,
  cookieOptions,
} from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { organizationsLive } from "@/adapters/organizations.live";

const MAX_BODY = 1024;

export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) {
    return NextResponse.json(
      new AdapterError("unavailable", "Demo mode does not use sign-in.").toJSON(),
      { status: HTTP_STATUS.unavailable },
    );
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) throw new Error("cross-origin");
    } catch {
      return NextResponse.json(
        new AdapterError("forbidden", "Cross-origin sign-in is not allowed.").toJSON(),
        { status: HTTP_STATUS.forbidden },
      );
    }
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return NextResponse.json(new AdapterError("invalid", "Request too large.").toJSON(), { status: 413 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const store = await cookies();
    const session = store.get(AUTH_COOKIES.mfaSession)?.value ?? "";
    const username = store.get(AUTH_COOKIES.mfaUsername)?.value ?? "";
    const email = store.get(AUTH_COOKIES.mfaEmail)?.value ?? "";
    const challenge = store.get(AUTH_COOKIES.mfaChallenge)?.value ?? "";
    if (!session || !username || !email || !["SOFTWARE_TOKEN_MFA", "MFA_SETUP"].includes(challenge)) {
      throw new AdapterError("unauthenticated", "The MFA sign-in attempt expired. Start again.");
    }
    if (typeof body.code !== "string") {
      throw new AdapterError("invalid", "Enter the six-digit authenticator code.");
    }
    const tokens = await completeMfaSignIn({
      session,
      username,
      email,
      code: body.code,
      challenge: challenge as "SOFTWARE_TOKEN_MFA" | "MFA_SETUP",
    });

    let orgId: string | null = null;
    try {
      await organizationsLive.claim(tokens.accessToken).catch(() => undefined);
      const orgs = await organizationsLive.mine(tokens.accessToken);
      orgId = orgs.find((org) => org.organizationId)?.organizationId ?? null;
    } catch {
      orgId = null;
    }

    const res = NextResponse.json({ data: { signedIn: true, email: tokens.email } });
    const twelveHours = 60 * 60 * 12;
    res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(twelveHours));
    res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(twelveHours));
    res.cookies.set(AUTH_COOKIES.expires, String(tokens.expiresAt), cookieOptions(twelveHours));
    res.cookies.set(AUTH_COOKIES.email, tokens.email, cookieOptions(twelveHours));
    if (orgId) res.cookies.set(AUTH_COOKIES.org, orgId, cookieOptions(twelveHours));
    for (const name of [
      AUTH_COOKIES.mfaSession,
      AUTH_COOKIES.mfaUsername,
      AUTH_COOKIES.mfaEmail,
      AUTH_COOKIES.mfaChallenge,
    ]) {
      res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return res;
  } catch (error) {
    const err = toAdapterError(error);
    console.error(`[auth] mfa ${err.code}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
