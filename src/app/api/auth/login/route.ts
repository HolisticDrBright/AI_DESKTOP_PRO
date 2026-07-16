import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions, passwordSignIn } from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";

/**
 * POST { email, password } → practitioner sign-in against the clinical
 * project's auth endpoint. Tokens land in httpOnly cookies only — the
 * response body never carries them. Demo/mock mode has no sign-in surface.
 */
export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) {
    return NextResponse.json(
      new AdapterError("unavailable", "Demo mode does not use sign-in.").toJSON(),
      { status: HTTP_STATUS.unavailable },
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email || !body.password) {
      throw new AdapterError("invalid", "Email and password are required.");
    }
    const tokens = await passwordSignIn(body.email.trim(), body.password);
    const res = NextResponse.json({ data: { signedIn: true, email: tokens.email } });
    const week = 60 * 60 * 24 * 7;
    res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.expires, String(tokens.expiresAt), cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.email, tokens.email, cookieOptions(week));
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] login ${err.code}: ${err.detail ?? err.message}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
