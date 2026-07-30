if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

/**
 * Clinical-edition configuration gate — server-only.
 *
 * The clinical edition FAILS CLOSED. If the configuration that makes real
 * clinical data possible is absent, the app reports that it is not configured;
 * it never degrades to fixtures, and it never renders an empty chart that a
 * practitioner could mistake for "this patient has no records".
 *
 * The demo edition asserts the inverse: it must not be given clinical
 * credentials at all, so a demo deployment cannot be nudged into live
 * behaviour by setting backend environment variables.
 */

import { APP_EDITION, EditionConfigError, IS_CLINICAL, IS_DEMO } from "./edition";
import type { AppEdition } from "./edition";

/** Server env that the clinical edition cannot operate without. */
const REQUIRED_CLINICAL_ENV = [
  "CLINICAL_SUPABASE_URL",
  "CLINICAL_SUPABASE_ANON_KEY",
] as const;

/**
 * Clinical credentials that must NOT be present in a demo deployment. A demo
 * build ignores them by construction (its adapters never call out), but their
 * presence means someone believes this deployment talks to real infrastructure
 * — which is exactly the confusion this split exists to remove.
 */
const FORBIDDEN_DEMO_ENV = [
  "CLINICAL_SUPABASE_URL",
  "CLINICAL_SUPABASE_ANON_KEY",
  "CLINICAL_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TRPC_BASE_URL",
  "CLINICAL_DEMO_EMAIL",
  "CLINICAL_DEMO_PASSWORD",
  "STRIPE_SECRET_KEY",
  "OPENAI_API_KEY",
] as const;

export interface EditionConfigReport {
  edition: AppEdition;
  ok: boolean;
  /** Required-but-missing server env (clinical edition only). */
  missing: string[];
  /** Clinical credentials present in a demo build (must be empty). */
  unexpected: string[];
}

function present(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}

/**
 * Inspect edition configuration without throwing. Used by the status panel and
 * by route handlers that need to answer "not configured" honestly.
 */
export function inspectEditionConfig(): EditionConfigReport {
  const missing = IS_CLINICAL
    ? REQUIRED_CLINICAL_ENV.filter((name) => !present(name))
    : [];
  const unexpected = IS_DEMO
    ? FORBIDDEN_DEMO_ENV.filter((name) => present(name))
    : [];
  return {
    edition: APP_EDITION,
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected,
  };
}

/**
 * True when the clinical edition has everything it needs to reach the
 * Desktop-owned boundary. Callers use this to render an honest
 * "not configured" state instead of attempting a request that cannot succeed.
 */
export function isClinicalBoundaryConfigured(): boolean {
  return IS_CLINICAL && REQUIRED_CLINICAL_ENV.every(present);
}

/**
 * Hard gate for server startup and clinical request paths. Throws rather than
 * allowing a half-configured clinical deployment to serve pages.
 */
export function assertEditionConfig(): void {
  const report = inspectEditionConfig();

  if (report.missing.length > 0) {
    throw new EditionConfigError(
      `The clinical edition is missing required configuration: ` +
        `${report.missing.join(", ")}. The clinical edition fails closed — ` +
        `set these before starting, or run the demo edition instead.`,
    );
  }

  if (report.unexpected.length > 0) {
    throw new EditionConfigError(
      `The demo edition was given clinical credentials: ` +
        `${report.unexpected.join(", ")}. A demo deployment must hold no real ` +
        `credentials. Remove them, or build the clinical edition.`,
    );
  }
}
