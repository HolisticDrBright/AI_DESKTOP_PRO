/**
 * APP EDITION — the single, typed authority for which product this build is.
 *
 * Two editions ship from this codebase:
 *
 *   demo      Interactive demo. Synthetic mock/session data only. No login, no
 *             credentials, no external service of any kind. Nothing persists
 *             past the browser session.
 *   clinical  Real practitioner software. Authenticated, organization-scoped,
 *             backed exclusively by the Desktop-owned Supabase boundary under
 *             RLS. Never renders fixture data and never falls back to mocks.
 *
 * WHY THIS MODULE EXISTS: no component, adapter, or route may read an edition
 * environment variable on its own. Scattered `process.env` reads are how a
 * "demo" build ends up with one live code path, or a clinical build quietly
 * renders a synthetic patient. Everything imports from here, and this is the
 * only place the edition environment is inspected.
 *
 * CLIENT SAFETY: this file reads only `NEXT_PUBLIC_*`, so it is safe in the
 * browser bundle. The operator sets plain `APP_EDITION`; `next.config.ts`
 * validates it with the same pure resolver and inlines it as
 * `NEXT_PUBLIC_APP_EDITION`. Server-only configuration checks live in
 * `edition.server.ts`.
 *
 * FAIL CLOSED: an unrecognized edition is never coerced to a default. It
 * throws at module load, which fails the build rather than shipping a product
 * whose data boundary nobody can name.
 */

import {
  APP_EDITIONS,
  DEFAULT_EDITION,
  EditionConfigError,
  resolveEdition,
  type AppEdition,
} from "./edition.build";

export {
  APP_EDITIONS,
  DEFAULT_EDITION,
  EditionConfigError,
  resolveEdition,
  type AppEdition,
};

/** The resolved edition for this build. */
export const APP_EDITION: AppEdition = resolveEdition(
  process.env.NEXT_PUBLIC_APP_EDITION,
  process.env.NEXT_PUBLIC_EDITION_LOCK,
);

export const IS_DEMO: boolean = APP_EDITION === "demo";
export const IS_CLINICAL: boolean = APP_EDITION === "clinical";

/**
 * The demo edition's promise, stated in the UI on every primary screen. Kept
 * here so the wording cannot drift between surfaces.
 */
export const DEMO_BANNER_TEXT = "Interactive demo — synthetic data only";

/** Guard for code paths that must never execute in the clinical edition. */
export function assertDemoEdition(what: string): void {
  if (!IS_DEMO) {
    throw new EditionConfigError(
      `${what} is demo-only and must not run in the ${APP_EDITION} edition.`,
    );
  }
}

/** Guard for code paths that require the real clinical boundary. */
export function assertClinicalEdition(what: string): void {
  if (!IS_CLINICAL) {
    throw new EditionConfigError(
      `${what} requires the clinical edition (this build is ${APP_EDITION}).`,
    );
  }
}

export interface EditionDescriptor {
  edition: AppEdition;
  isDemo: boolean;
  isClinical: boolean;
  /** Human label for status panels. */
  label: string;
  /** One honest sentence about where this build's data comes from. */
  dataBoundary: string;
}

export function describeEdition(): EditionDescriptor {
  return IS_DEMO
    ? {
        edition: "demo",
        isDemo: true,
        isClinical: false,
        label: "Demo edition",
        dataBoundary:
          "Synthetic fixtures and per-session browser state only. No backend, " +
          "no credentials, no external services, nothing persisted.",
      }
    : {
        edition: "clinical",
        isDemo: false,
        isClinical: true,
        label: "Clinical edition",
        dataBoundary:
          "Live records from the Desktop-owned Supabase boundary under the " +
          "signed-in practitioner's session and RLS. No fixture data.",
      };
}
