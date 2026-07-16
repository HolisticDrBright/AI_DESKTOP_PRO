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
 * ⚠️ LOCAL/E2E FALLBACK ONLY. The active organization now comes from the
 * practitioner's session (validated `aidp_org` cookie, set at sign-in or via
 * the Settings switcher). This env value exists solely for headless local
 * runs and the contract-fixture e2e suite — do NOT set it in a real
 * deployment.
 */
const ENV_FALLBACK_ORG_ID =
  process.env.CLINICAL_ORG_ID ?? process.env.NEXT_PUBLIC_DEV_ORG_ID ?? "";

import { AdapterError } from "./errors";

/**
 * Resolve the organization an org-scoped live call runs against: the
 * session's validated org first, the env fallback second (local/e2e only),
 * otherwise a clean, actionable error — never a silent empty scope.
 */
export function resolveOrgId(orgId?: string | null): string {
  const resolved = orgId || ENV_FALLBACK_ORG_ID;
  if (!resolved) {
    throw new AdapterError(
      "invalid",
      "No organization selected. Choose your organization in Settings.",
    );
  }
  return resolved;
}
