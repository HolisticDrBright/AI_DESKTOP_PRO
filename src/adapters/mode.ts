/**
 * Data-source mode + practitioner context (client-safe).
 *
 * One place decides whether the app talks to the mock/demo layer or the live
 * backend, and one place resolves the dev-only identity overrides. Reads only
 * `NEXT_PUBLIC_*` env, so it is safe in the browser bundle and never exposes a
 * secret (server credentials live in server-only modules).
 *
 * Flag: NEXT_PUBLIC_USE_LIVE_API = "true" | "1"  -> live
 *       anything else / unset                     -> mock  (default)
 */

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true";
}

export type ApiMode = "live" | "mock";

/** True when the app should route flag-enabled namespaces to the live backend. */
export const USE_LIVE_API = truthy(process.env.NEXT_PUBLIC_USE_LIVE_API);

export function getApiMode(): ApiMode {
  return USE_LIVE_API ? "live" : "mock";
}

/**
 * Dev-only identity overrides.
 *
 * ⚠️ LOCAL DEVELOPMENT ONLY — UNSAFE FOR PRODUCTION. These let a developer
 * pin an org/patient/practitioner for the live-path proof before the real
 * login UI exists. They are NOT authentication: the backend still enforces
 * RLS against the practitioner's actual session token. In production the
 * practitioner id comes from the authenticated session, never from these.
 */
export interface DevContext {
  orgId?: string;
  patientId?: string;
  practitionerId?: string;
}

export function getDevContext(): DevContext {
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
  mode: ApiMode;
  live: boolean;
  devOverrides: { orgId: boolean; patientId: boolean; practitionerId: boolean };
  anyDevOverride: boolean;
}

export function describeMode(): ModeStatus {
  const c = getDevContext();
  return {
    mode: getApiMode(),
    live: USE_LIVE_API,
    devOverrides: {
      orgId: Boolean(c.orgId),
      patientId: Boolean(c.patientId),
      practitionerId: Boolean(c.practitionerId),
    },
    anyDevOverride: hasDevOverrides(),
  };
}
