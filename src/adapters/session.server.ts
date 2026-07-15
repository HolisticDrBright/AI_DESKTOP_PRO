if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * DEMO server-side session bootstrap for the live-path proof (Item 6).
 *
 * The desktop has no login UI yet. To exercise the authenticated tRPC path
 * end to end, this obtains a real access token for a demo practitioner by
 * password-granting against the CLINICAL project's Supabase Auth (identity
 * only — never a Postgres data connection). The token is then presented to
 * the tRPC backend as a bearer, so RLS runs as that real user.
 *
 * This is scaffolding, not the product's auth: the shipped flow will carry
 * the practitioner's own session. It is server-only, and only ever invoked
 * when USE_LIVE_API is on. No credentials or tokens are logged.
 */

let cached: { token: string; expiresAt: number } | null = null;

export async function getClinicalAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 30_000 > now) return cached.token;

  const url = process.env.CLINICAL_SUPABASE_URL;
  const anon = process.env.CLINICAL_SUPABASE_ANON_KEY;
  const email = process.env.CLINICAL_DEMO_EMAIL;
  const password = process.env.CLINICAL_DEMO_PASSWORD;
  if (!url || !anon || !email || !password) {
    throw new Error(
      "Live API demo session is not configured (CLINICAL_SUPABASE_URL / _ANON_KEY / _DEMO_EMAIL / _DEMO_PASSWORD)",
    );
  }

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Demo session sign-in failed (${res.status})`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Demo session returned no access token");

  cached = {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}
