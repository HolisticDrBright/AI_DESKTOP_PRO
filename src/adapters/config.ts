/**
 * Data-source feature flag (Item 6 of the server-layer slice).
 *
 * Default: MOCK. The desktop ships on mock adapters until each namespace's
 * live parity is proven. Set NEXT_PUBLIC_USE_LIVE_API=1 to route flag-enabled
 * namespaces through the authenticated tRPC backend instead.
 *
 * IMPORTANT: even when live, the desktop talks ONLY to the tRPC backend over
 * HTTP — never to Postgres/Supabase data directly (ADR 0002). The backend
 * enforces RLS + the procedure guards.
 */
export const USE_LIVE_API = process.env.NEXT_PUBLIC_USE_LIVE_API === "1";

/** Base URL of the shared tRPC backend (rork-ai-longevity-coach). */
export const TRPC_BASE_URL =
  process.env.TRPC_BASE_URL ?? "http://localhost:3000/api/trpc";

/**
 * The organization the desktop operates in. In the real product this comes
 * from the practitioner's session (organizations.mine); for the live-path
 * proof it is provided by env so a server component can scope its query.
 */
export const ACTIVE_ORG_ID = process.env.CLINICAL_ORG_ID ?? "";
