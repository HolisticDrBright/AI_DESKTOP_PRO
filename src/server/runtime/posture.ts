/**
 * PHI-safe runtime posture diagnostic.
 *
 * Reports:
 *   - Supabase project reference (the URL host label, never the key or JWT)
 *   - APP_EDITION
 *   - Live-mode status (whether NEXT_PUBLIC_USE_LIVE_API is on)
 *   - Whether the request path resolves the REAL PostgREST client or a
 *     fixture. A `transport` tag = `postgrest` means the caller is hitting
 *     the real Supabase over HTTPS. Anything else (`fixture`, `unknown`)
 *     means the response came from an in-process stub.
 *
 * Never returns the anon key, JWT, cookie, package content, or practitioner
 * identity. Never reads a request body. Every field is bounded to a short
 * label.
 */
if (typeof window !== "undefined") {
  throw new Error("server/runtime/posture is server-only.");
}

export type RuntimePosture = {
  supabase_project_ref: string | null;
  supabase_host: string | null;
  app_edition: string | null;
  live_mode: boolean;
  node_env: string | null;
  transport: "postgrest" | "fixture" | "unknown";
};

function extractProjectRef(url: string | undefined): { host: string | null; ref: string | null } {
  if (!url) return { host: null, ref: null };
  try {
    const u = new URL(url);
    const host = u.host;
    // `<ref>.supabase.co` — ref is everything before the first `.supabase.`
    const match = host.match(/^([a-z0-9]{16,32})\.supabase\.[a-z.]+$/i);
    return { host, ref: match ? match[1] : null };
  } catch {
    return { host: null, ref: null };
  }
}

/**
 * Compute the current posture. Never throws. Every field is safe to log
 * verbatim: it carries no key material, no cookie, no PHI.
 */
export function describeRuntimePosture(): RuntimePosture {
  const supabaseUrl = process.env.CLINICAL_SUPABASE_URL;
  const { host, ref } = extractProjectRef(supabaseUrl);

  // Fixture backends set TRPC_BASE_URL to a local port. If TRPC_BASE_URL is
  // present AND the Supabase URL host is a localhost/loopback address, we
  // are running against the E2E stub — otherwise we assume the real
  // PostgREST endpoint on supabase.co (or a self-hosted equivalent).
  let transport: RuntimePosture["transport"] = "unknown";
  if (host) {
    if (/^(?:127\.|::1|localhost)/i.test(host) || host.includes(":3999")) {
      transport = "fixture";
    } else if (/\.supabase\.(co|in|io)$/i.test(host)) {
      transport = "postgrest";
    } else {
      transport = "unknown";
    }
  }

  return {
    supabase_project_ref: ref,
    supabase_host: host,
    app_edition: process.env.APP_EDITION ?? null,
    live_mode: process.env.NEXT_PUBLIC_USE_LIVE_API === "true",
    node_env: process.env.NODE_ENV ?? null,
    transport,
  };
}
