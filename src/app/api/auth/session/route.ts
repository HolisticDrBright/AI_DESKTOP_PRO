import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AUTH_COOKIES,
  cookieOptions,
  readAuthSession,
  refreshSession,
} from "@/adapters/auth.server";
import { USE_LIVE_API } from "@/adapters/mode";

/**
 * GET → current practitioner session state. Route-handler scope may write
 * cookies, so this is also where near-expiry sessions are refreshed (Supabase
 * rotates the refresh token; both cookies are replaced).
 */
export async function GET() {
  if (!USE_LIVE_API) {
    return NextResponse.json({ data: { mode: "mock", signedIn: false, email: null, orgId: null } });
  }
  const session = readAuthSession(await cookies());

  // Refresh when expired (or inside the 10-minute window) and a refresh token exists.
  const nearExpiry =
    session.accessToken && session.expiresAt && Date.now() > session.expiresAt - 10 * 60_000;
  if ((session.expired || nearExpiry) && session.refreshToken) {
    try {
      const tokens = await refreshSession(session.refreshToken);
      const res = NextResponse.json({
        data: { mode: "live", signedIn: true, email: tokens.email || session.email },
      });
      const week = 60 * 60 * 24 * 7;
      res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(week));
      res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(week));
      res.cookies.set(AUTH_COOKIES.expires, String(tokens.expiresAt), cookieOptions(week));
      if (tokens.email) res.cookies.set(AUTH_COOKIES.email, tokens.email, cookieOptions(week));
      return res;
    } catch {
      // Refresh failed (revoked/expired) → treat as signed out; clear cookies.
      const res = NextResponse.json({ data: { mode: "live", signedIn: false, email: null } });
      for (const name of Object.values(AUTH_COOKIES)) {
        res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
      }
      return res;
    }
  }

  return NextResponse.json({
    data: {
      mode: "live",
      signedIn: session.signedIn,
      email: session.signedIn ? session.email : null,
      orgId: session.signedIn ? session.orgId : null,
    },
  });
}
