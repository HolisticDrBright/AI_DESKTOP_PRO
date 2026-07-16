import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions, refreshSession } from "@/adapters/auth.server";
import { AdapterError } from "@/adapters/errors";

/**
 * Global authentication lifecycle (P0). LIVE mode only — the demo runs with no
 * auth and this middleware steps aside entirely.
 *
 * On every app request:
 *  - fully signed out → pages redirect to /login?next=…; APIs answer their
 *    own 401s (the local/e2e env fallback stays possible there)
 *  - access token expired or inside the 10-minute window, refresh token
 *    present → refresh with rotation (single-flight per refresh token so
 *    concurrent tabs don't race), set the rotated cookies, and for an
 *    EXPIRED page request redirect to the same URL so it re-runs with the
 *    fresh session
 *  - refresh rejected (revoked/expired) → clear cookies; pages go to /login
 *  - transient refresh failure (backend down) → continue without destroying
 *    the session; downstream states handle unavailability honestly
 */

const LIVE =
  process.env.NEXT_PUBLIC_USE_LIVE_API === "true" ||
  process.env.NEXT_PUBLIC_USE_LIVE_API === "1";
const WEEK = 60 * 60 * 24 * 7;
const REFRESH_WINDOW_MS = 10 * 60_000;
/**
 * The documented LOCAL/E2E-ONLY fallback session. When it is configured,
 * signed-out pages render using it (as the API layer already does) instead of
 * forcing /login. It must never be set in a real deployment — with it unset,
 * every page requires a practitioner session.
 */
const HAS_ENV_FALLBACK = Boolean(
  process.env.CLINICAL_DEMO_EMAIL && process.env.CLINICAL_DEMO_PASSWORD,
);

type Tokens = Awaited<ReturnType<typeof refreshSession>>;
const inflight = new Map<string, Promise<Tokens>>();

function setAuthCookies(res: NextResponse, tokens: Tokens) {
  res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(WEEK));
  res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(WEEK));
  res.cookies.set(AUTH_COOKIES.expires, String(tokens.expiresAt), cookieOptions(WEEK));
  if (tokens.email) res.cookies.set(AUTH_COOKIES.email, tokens.email, cookieOptions(WEEK));
}

function clearAuthCookies(res: NextResponse) {
  for (const name of Object.values(AUTH_COOKIES)) {
    res.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  }
}

function loginRedirect(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  if (!LIVE) return NextResponse.next();

  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  // Public auth pages: reachable signed-out (reset links arrive by email).
  const isLogin = pathname === "/login" || pathname === "/reset";
  // The auth endpoints manage cookies themselves — never intercept them.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  const access = req.cookies.get(AUTH_COOKIES.access)?.value ?? "";
  const refresh = req.cookies.get(AUTH_COOKIES.refresh)?.value ?? "";
  const expRaw = Number(req.cookies.get(AUTH_COOKIES.expires)?.value ?? "");
  const expiresAt = Number.isFinite(expRaw) ? expRaw : 0;
  const now = Date.now();
  const expired = Boolean(access) && now >= expiresAt;
  const nearExpiry = Boolean(access) && !expired && now > expiresAt - REFRESH_WINDOW_MS;

  if (!access && !refresh) {
    if (!isApi && !isLogin && !HAS_ENV_FALLBACK) return loginRedirect(req);
    return NextResponse.next();
  }

  if ((expired || nearExpiry || !access) && refresh) {
    let entry = inflight.get(refresh);
    if (!entry) {
      entry = refreshSession(refresh);
      inflight.set(refresh, entry);
      // Swallow here so the shared promise never surfaces as an unhandled
      // rejection — each awaiter below handles the failure itself. Brief
      // retention lets concurrent requests share one rotation.
      void entry
        .catch(() => undefined)
        .finally(() => {
          setTimeout(() => inflight.delete(refresh), 2_000);
        });
    }
    try {
      const tokens = await entry;
      const stale = expired || !access;
      const res =
        stale && !isApi
          ? NextResponse.redirect(req.nextUrl) // re-run with the fresh session
          : NextResponse.next();
      setAuthCookies(res, tokens);
      return res;
    } catch (e) {
      const revoked = e instanceof AdapterError && e.code === "unauthenticated";
      if (revoked) {
        const res =
          !isApi && !isLogin && !HAS_ENV_FALLBACK ? loginRedirect(req) : NextResponse.next();
        clearAuthCookies(res);
        return res;
      }
      // Transient (backend unreachable): keep the session; pages/APIs surface
      // their own honest unavailable states.
      return NextResponse.next();
    }
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|ico|css|js|map|txt)).*)"],
};
