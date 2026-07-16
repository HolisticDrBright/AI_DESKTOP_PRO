import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, cookieOptions, passwordSignIn } from "@/adapters/auth.server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import { organizationsLive } from "@/adapters/organizations.live";

/**
 * POST { email, password } → practitioner sign-in against the clinical
 * project's auth endpoint. Tokens land in httpOnly cookies only — the
 * response body never carries them. Demo/mock mode has no sign-in surface.
 *
 * P0 hygiene: same-origin enforcement (Origin must match Host when present),
 * a small body cap, and per-IP rate limiting against credential stuffing
 * (in-memory fixed window — swap for a shared store when scaling out).
 */
const MAX_LOGIN_BODY = 4 * 1024;
const LOGIN_ATTEMPTS_PER_MINUTE = 10;
const loginWindows = new Map<string, { count: number; resetAt: number }>();

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
      if (new URL(origin).host !== host) {
        return NextResponse.json(
          new AdapterError("forbidden", "Cross-origin sign-in is not allowed.").toJSON(),
          { status: HTTP_STATUS.forbidden },
        );
      }
    } catch {
      return NextResponse.json(
        new AdapterError("forbidden", "Cross-origin sign-in is not allowed.").toJSON(),
        { status: HTTP_STATUS.forbidden },
      );
    }
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_LOGIN_BODY) {
    return NextResponse.json(
      new AdapterError("invalid", "Request too large.").toJSON(),
      { status: 413 },
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const w = loginWindows.get(ip);
  if (!w || now >= w.resetAt) {
    loginWindows.set(ip, { count: 1, resetAt: now + 60_000 });
  } else if (w.count >= LOGIN_ATTEMPTS_PER_MINUTE) {
    return NextResponse.json(
      new AdapterError("unavailable", "Too many sign-in attempts. Try again in a minute.").toJSON(),
      { status: 429 },
    );
  } else {
    w.count += 1;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string" || !body.email || !body.password) {
      throw new AdapterError("invalid", "Email and password are required.");
    }
    const tokens = await passwordSignIn(body.email.trim(), body.password);

    // Auto-select the organization when the practitioner has exactly one (or
    // default to the first). Pending invitations are claimed first, so a
    // newly invited practitioner's first sign-in activates their membership.
    // Tolerated failure: Settings offers selection.
    let orgId: string | null = null;
    try {
      await organizationsLive.claim(tokens.accessToken).catch(() => undefined);
      const orgs = await organizationsLive.mine(tokens.accessToken);
      orgId = orgs.find((o) => o.organizationId)?.organizationId ?? null;
    } catch {
      orgId = null;
    }

    const res = NextResponse.json({ data: { signedIn: true, email: tokens.email } });
    const week = 60 * 60 * 24 * 7;
    res.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.expires, String(tokens.expiresAt), cookieOptions(week));
    res.cookies.set(AUTH_COOKIES.email, tokens.email, cookieOptions(week));
    if (orgId) res.cookies.set(AUTH_COOKIES.org, orgId, cookieOptions(week));
    return res;
  } catch (e) {
    const err = toAdapterError(e);
    console.error(`[auth] login ${err.code}: ${err.detail ?? err.message}`);
    return NextResponse.json(err.toJSON(), { status: HTTP_STATUS[err.code] });
  }
}
