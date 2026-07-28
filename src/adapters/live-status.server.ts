if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * Server-side view of live data-source configuration — PRESENCE ONLY.
 *
 * Reports whether each server-only env var is set, never its value, so the
 * Settings status panel can show "configured / not configured" without any
 * secret ever reaching the client bundle.
 */
export interface LiveServerStatus {
  clinicalSupabaseConfigured: boolean;
  trpcConfigured: boolean;
  demoSessionConfigured: boolean;
  orgConfigured: boolean;
}

export function getLiveServerStatus(): LiveServerStatus {
  return {
    clinicalSupabaseConfigured: Boolean(
      process.env.CLINICAL_SUPABASE_URL && process.env.CLINICAL_SUPABASE_ANON_KEY,
    ),
    trpcConfigured: Boolean(process.env.TRPC_BASE_URL),
    demoSessionConfigured: Boolean(
      process.env.CLINICAL_SUPABASE_URL &&
        process.env.CLINICAL_SUPABASE_ANON_KEY &&
        process.env.CLINICAL_DEMO_EMAIL &&
        process.env.CLINICAL_DEMO_PASSWORD,
    ),
    orgConfigured: Boolean(process.env.CLINICAL_ORG_ID || process.env.NEXT_PUBLIC_DEV_ORG_ID),
  };
}
