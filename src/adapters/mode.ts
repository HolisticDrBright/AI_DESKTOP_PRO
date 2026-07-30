/**
 * Data-source mode + practitioner context (client-safe) — CLINICAL-ONLY.
 *
 * This repository ships the clinical product; `next.config.ts` hard-locks the
 * edition and refuses to build anything else. The demo edition lives in
 * `AI-DESKTOP-PRO-DEMO`. There is no mock mode here: every adapter either
 * reaches the Desktop-owned boundary under the practitioner's session or
 * reports an honest unavailable / not-configured state.
 *
 * DEPRECATED: `USE_LIVE_API`. It was the mock/live switch, then a derived
 * alias of the edition, and is now a constant `true` kept only so the few
 * remaining imports compile during the migration recorded in
 * `docs/clinical-runtime-migration.md`. New code must not import it — being
 * "live" is not a mode of this product, it is the product.
 */

import { APP_EDITION, IS_CLINICAL } from "@/lib/edition";

export type ApiMode = "live";

/** @deprecated Always true in the clinical repository. Do not import in new code. */
export const USE_LIVE_API = true as const;

export function getApiMode(): ApiMode {
  return "live";
}

/**
 * Dev-only identity overrides.
 *
 * ⚠️ LOCAL DEVELOPMENT ONLY — UNSAFE FOR PRODUCTION. These let a developer
 * pin an org/patient/practitioner for the live-path proof. They are NOT
 * authentication: the backend still enforces RLS against the practitioner's
 * actual session token. In production the practitioner id comes from the
 * authenticated session, never from these.
 */
export interface DevContext {
  orgId?: string;
  patientId?: string;
  practitionerId?: string;
}

export function getDevContext(): DevContext {
  if (!IS_CLINICAL) return {};
  return {
    orgId: process.env.NEXT_PUBLIC_DEV_ORG_ID || undefined,
    patientId: process.env.NEXT_PUBLIC_DEV_PATIENT_ID || undefined,
    practitionerId: process.env.NEXT_PUBLIC_DEV_PRACTITIONER_ID || undefined,
  };
}

export function hasDevOverrides(): boolean {
  const c = getDevContext();
  return Boolean(c.orgId || c.patientId || c.practitionerId);
}

/**
 * Client-safe status descriptor for the env/status panel. Reports PRESENCE
 * only (booleans) — never the underlying values.
 */
export interface ModeStatus {
  edition: typeof APP_EDITION;
  mode: ApiMode;
  live: true;
  devOverrides: { orgId: boolean; patientId: boolean; practitionerId: boolean };
  anyDevOverride: boolean;
}

export function describeMode(): ModeStatus {
  const c = getDevContext();
  return {
    edition: APP_EDITION,
    mode: "live",
    live: true,
    devOverrides: {
      orgId: Boolean(c.orgId),
      patientId: Boolean(c.patientId),
      practitionerId: Boolean(c.practitionerId),
    },
    anyDevOverride: hasDevOverrides(),
  };
}
