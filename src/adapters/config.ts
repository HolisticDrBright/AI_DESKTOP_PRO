/**
 * Backend configuration for the live data path.
 *
 * The mock/live decision now lives in `./mode.ts` (the single source of truth,
 * client-safe, and accepts `NEXT_PUBLIC_USE_LIVE_API=true|1`). This module
 * re-exports the flag for existing importers and adds the server-only backend
 * endpoints used by the live modules.
 *
 * IMPORTANT: even when live, the desktop talks ONLY to the tRPC backend over
 * HTTP — never to Postgres/Supabase data directly (ADR 0002). The backend
 * enforces RLS + the procedure guards, and is the one place that calls the
 * SECURITY DEFINER RPCs (migration 0013) as the authenticated practitioner.
 */
export { USE_LIVE_API } from "./mode";

/** Base URL of the shared tRPC backend (rork-ai-longevity-coach). Server-only. */
export const TRPC_BASE_URL =
  process.env.TRPC_BASE_URL ?? "http://localhost:3000/api/trpc";

/**
 * The organization the desktop operates in. In the real product this comes
 * from the practitioner's session (organizations.mine); for the live-path
 * proof it is provided by env so a server component can scope its query.
 * Falls back to the dev override so a single value can drive both.
 */
export const ACTIVE_ORG_ID =
  process.env.CLINICAL_ORG_ID ?? process.env.NEXT_PUBLIC_DEV_ORG_ID ?? "";
