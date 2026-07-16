if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { AdapterError } from "./errors";

/**
 * Access-token source for the live tRPC path, in strict order:
 *
 *  1. The signed-in practitioner's session (httpOnly cookies set by
 *     /api/auth/login — real Supabase Auth). This is the product path.
 *  2. ⚠️ LOCAL/E2E FALLBACK ONLY: env demo credentials
 *     (CLINICAL_DEMO_EMAIL/PASSWORD). Kept so the contract-fixture e2e suite
 *     and headless local runs work without a browser session. Do NOT set
 *     these in a real deployment — the cookie session is the intended auth.
 *  3. Neither → AdapterError("unauthenticated"): the UI shows the signed-out
 *     state with a sign-in link (distinct from "forbidden" = signed in but
 *     not permitted, which RLS/the backend reports per-record).
 *
 * Expired cookie sessions are refreshed by /api/auth/session (route-handler
 * scope owns cookie writes); here an expired session simply falls through.
 * No credentials or tokens are ever logged.
 */

let cached: { token: string; expiresAt: number } | null = null;

async function envFallbackToken(): Promise<string | null> {
  const url = process.env.CLINICAL_SUPABASE_URL;
  const anon = process.env.CLINICAL_SUPABASE_ANON_KEY;
  const email = process.env.CLINICAL_DEMO_EMAIL;
  const password = process.env.CLINICAL_DEMO_PASSWORD;
  if (!url || !anon || !email || !password) return null;

  const now = Date.now();
  if (cached && cached.expiresAt - 30_000 > now) return cached.token;

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new AdapterError("unauthenticated", undefined, `env fallback sign-in ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new AdapterError("unauthenticated", undefined, "env fallback returned no token");
  }
  cached = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

/**
 * @param sessionToken The signed-in practitioner's access token, read from the
 * httpOnly cookie session by an app-router file (src/server/session.ts) and
 * threaded through the live call. Adapters never read cookies themselves.
 */
export async function getClinicalAccessToken(sessionToken?: string | null): Promise<string> {
  if (sessionToken) return sessionToken;

  const fallback = await envFallbackToken();
  if (fallback) return fallback;

  throw new AdapterError("unauthenticated", "Sign in to access live clinical data.");
}
