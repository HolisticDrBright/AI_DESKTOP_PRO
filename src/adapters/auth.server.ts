if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { AdapterError } from "./errors";

/**
 * Practitioner session for LIVE mode — real Supabase Auth sign-in, held in
 * httpOnly cookies. The browser never sees tokens or Supabase; this module
 * (and the /api/auth/* route handlers that own cookie writes) do the
 * password/refresh grants server-side against the CLINICAL project's auth
 * endpoint — identity only, never a data connection (ADR 0002).
 *
 * Cookie model (all httpOnly, sameSite=lax, secure in production):
 *   aidp_at  — access token (JWT presented to the tRPC backend as bearer)
 *   aidp_rt  — refresh token (rotated by Supabase on each refresh)
 *   aidp_exp — access-token expiry (epoch ms), for cheap freshness checks
 *   aidp_em  — signed-in email, display only (no PHI)
 *
 * Refresh happens ONLY in route-handler scope (/api/auth/session), where
 * cookies may be written; server components read the session as-is.
 *
 * IMPORTANT: this module never imports next/headers (adapters are reachable
 * from the client module graph). Cookie access lives in app-router files
 * (src/server/session.ts, the auth routes, server components), which pass a
 * cookie store into readAuthSession.
 */

export const AUTH_COOKIES = {
  access: "aidp_at",
  refresh: "aidp_rt",
  expires: "aidp_exp",
  email: "aidp_em",
  /** Active organization (validated against memberships before it is set). */
  org: "aidp_org",
} as const;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  email: string;
}

export interface AuthSessionState {
  signedIn: boolean;
  email: string | null;
  /** True when an access token exists but is past expiry (needs refresh/sign-in). */
  expired: boolean;
  expiresAt: number | null;
  /** Active organization id (from the validated org cookie), or null. */
  orgId: string | null;
}

function authBase(): { url: string; anon: string } {
  const url = process.env.CLINICAL_SUPABASE_URL;
  const anon = process.env.CLINICAL_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new AdapterError(
      "unavailable",
      "Live sign-in is not configured on this deployment.",
      "CLINICAL_SUPABASE_URL / CLINICAL_SUPABASE_ANON_KEY missing",
    );
  }
  return { url, anon };
}

interface GrantResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { email?: string };
}

async function grant(body: Record<string, string>, kind: "password" | "refresh_token"): Promise<AuthTokens> {
  const { url, anon } = authBase();
  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=${kind}`, {
      method: "POST",
      headers: { apikey: anon, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    throw new AdapterError("unavailable", undefined, `auth grant: ${e instanceof Error ? e.message : "network"}`);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // Wrong credentials / revoked refresh token. Never echo server detail.
    throw new AdapterError("unauthenticated", "Sign-in failed — check your email and password.");
  }
  if (!res.ok) throw new AdapterError("unavailable", undefined, `auth grant status ${res.status}`);
  const data = (await res.json()) as GrantResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new AdapterError("unauthenticated", "Sign-in failed — check your email and password.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    email: data.user?.email ?? body.email ?? "",
  };
}

export function passwordSignIn(email: string, password: string): Promise<AuthTokens> {
  return grant({ email, password }, "password");
}

/**
 * Request a password-reset email. Enumeration-safe by design: any non-network
 * outcome resolves — callers always show the same "if an account exists…"
 * message. Only a network/config failure throws (honest unavailable state).
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const { url, anon } = authBase();
  try {
    await fetch(`${url}/auth/v1/recover`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anon },
      body: JSON.stringify({ email }),
      cache: "no-store",
    });
  } catch (e) {
    throw new AdapterError(
      "unavailable",
      "The reset service is unreachable right now. Please try again.",
      e instanceof Error ? e.message : undefined,
    );
  }
}

/**
 * Complete a reset using the RECOVERY access token from the emailed link
 * (Supabase puts it in the URL fragment, so only the browser ever sees it —
 * it reaches us in a POST body, is used once here, and is never stored).
 */
export async function completePasswordReset(
  recoveryAccessToken: string,
  newPassword: string,
): Promise<void> {
  const { url, anon } = authBase();
  let res: Response;
  try {
    res = await fetch(`${url}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        apikey: anon,
        Authorization: `Bearer ${recoveryAccessToken}`,
      },
      body: JSON.stringify({ password: newPassword }),
      cache: "no-store",
    });
  } catch (e) {
    throw new AdapterError(
      "unavailable",
      "The reset service is unreachable right now. Please try again.",
      e instanceof Error ? e.message : undefined,
    );
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AdapterError(
      "unauthenticated",
      "This reset link is invalid or has expired. Request a new one.",
    );
  }
  if (!res.ok) {
    throw new AdapterError("unavailable", "Could not update the password. Please try again.");
  }
}

export function refreshSession(refreshToken: string): Promise<AuthTokens> {
  return grant({ refresh_token: refreshToken }, "refresh_token");
}

/** Minimal cookie-store shape (matches next/headers' ReadonlyRequestCookies). */
export interface CookieStoreLike {
  get(name: string): { value: string } | undefined;
}

/** Read the session from a request cookie store passed in by an app-router file. */
export function readAuthSession(
  store: CookieStoreLike,
): AuthSessionState & { accessToken: string | null; refreshToken: string | null } {
  const accessToken = store.get(AUTH_COOKIES.access)?.value ?? null;
  const refreshToken = store.get(AUTH_COOKIES.refresh)?.value ?? null;
  const email = store.get(AUTH_COOKIES.email)?.value ?? null;
  const expiresAt = Number(store.get(AUTH_COOKIES.expires)?.value ?? 0) || null;
  const expired = Boolean(accessToken && expiresAt && Date.now() > expiresAt - 30_000);
  const orgId = store.get(AUTH_COOKIES.org)?.value || null;
  return {
    signedIn: Boolean(accessToken && !expired),
    email,
    expired,
    expiresAt,
    orgId,
    accessToken,
    refreshToken,
  };
}

/** Cookie attributes shared by the auth route handlers. */
export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
