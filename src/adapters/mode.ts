/**
 * Data-source mode + practitioner context (client-safe).
 *
 * THE EDITION IS THE AUTHORITY. `APP_EDITION` (see `src/lib/edition.ts`)
 * decides whether this build talks to the Desktop-owned clinical boundary or
 * to synthetic fixtures. This module derives the adapter-facing view of that
 * decision; it does not make its own.
 *
 *   clinical edition -> live adapters, authenticated, RLS-scoped
 *   demo edition     -> mock/session adapters, no network, nothing persisted
 *
 * DEPRECATED: `NEXT_PUBLIC_USE_LIVE_API`.
 *
 * That flag used to be the top-level switch. It is no longer consulted for the
 * edition decision — a demo build cannot be turned live by setting it, which is
 * the entire point of the edition split. It survives only as a derived alias
 * (`USE_LIVE_API`) so the ~40 existing call sites and the current test suites
 * keep compiling while they migrate to `IS_CLINICAL` / `IS_DEMO`.
 *
 * Migration path for call sites: replace `USE_LIVE_API` with `IS_CLINICAL`
 * from `@/lib/edition`. Removal is tracked in `docs/app-editions.md`; the
 * alias goes away once no source file imports it.
 */

import { APP_EDITION, IS_CLINICAL, IS_DEMO } from "@/lib/edition";

export type ApiMode = "live" | "mock";

/**
 * @deprecated Derived from `APP_EDITION`. Use `IS_CLINICAL` from
 * `@/lib/edition` instead. Setting `NEXT_PUBLIC_USE_LIVE_API` no longer
 * affects this value.
 */
export const USE_LIVE_API: boolean = IS_CLINICAL;

export function getApiMode(): ApiMode {
  return IS_CLINICAL ? "live" : "mock";
}

/**
 * Dev-only identity overrides.
 *
 * ⚠️ LOCAL DEVELOPMENT ONLY — UNSAFE FOR PRODUCTION. These let a developer
 * pin an org/patient/practitioner for the live-path proof. They are NOT
 * authentication: the backend still enforces RLS against the practitioner's
 * actual session token. In production the practitioner id comes from the
 * authenticated session, never from these.
 *
 * The demo edition ignores them entirely — it has no live path to point at, so
 * an override cannot conjure one.
 */
export interface DevContext {
  orgId?: string;
  patientId?: string;
  practitionerId?: string;
}

export function getDevContext(): DevContext {
  if (IS_DEMO) return {};
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
  live: boolean;
  devOverrides: { orgId: boolean; patientId: boolean; practitionerId: boolean };
  anyDevOverride: boolean;
}

export function describeMode(): ModeStatus {
  const c = getDevContext();
  return {
    edition: APP_EDITION,
    mode: getApiMode(),
    live: IS_CLINICAL,
    devOverrides: {
      orgId: Boolean(c.orgId),
      patientId: Boolean(c.patientId),
      practitionerId: Boolean(c.practitionerId),
    },
    anyDevOverride: hasDevOverrides(),
  };
}
