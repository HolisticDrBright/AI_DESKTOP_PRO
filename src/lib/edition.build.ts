/**
 * Edition vocabulary and resolution — PURE.
 *
 * This module reads no environment and holds no state, so it can be imported
 * from three places that must agree exactly: `next.config.ts` (build-time
 * validation), `src/lib/edition.ts` (the runtime authority), and the unit
 * tests. Keeping the rules here is what makes "the build and the app cannot
 * disagree about which edition this is" a structural property rather than a
 * convention.
 *
 * Application code should import from `./edition`, not from this file.
 */

export type AppEdition = "demo" | "clinical";

export const APP_EDITIONS: readonly AppEdition[] = ["demo", "clinical"] as const;

/** The safe default: no credentials, no network, nothing real. */
export const DEFAULT_EDITION: AppEdition = "demo";

export class EditionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditionConfigError";
  }
}

export function isEdition(value: string): value is AppEdition {
  return (APP_EDITIONS as readonly string[]).includes(value);
}

/**
 * Resolve an edition from a requested value and an optional distribution lock.
 *
 * Rules, in order:
 *   1. An invalid `lock` is a configuration error.
 *   2. Empty request falls back to the lock, then to the default (`demo`).
 *   3. An invalid request is a configuration error — never coerced to default.
 *   4. A request that contradicts the lock is a configuration error.
 *
 * Every failure throws. Nothing here silently picks a data boundary.
 */
export function resolveEdition(
  raw: string | undefined,
  lock?: string | undefined,
): AppEdition {
  const requested = (raw ?? "").trim().toLowerCase();
  const locked = (lock ?? "").trim().toLowerCase();

  if (locked && !isEdition(locked)) {
    throw new EditionConfigError(
      `EDITION_LOCK is "${locked}", which is not a valid edition. ` +
        `Expected one of: ${APP_EDITIONS.join(", ")}.`,
    );
  }

  if (requested && !isEdition(requested)) {
    throw new EditionConfigError(
      `APP_EDITION is "${requested}", which is not a valid edition. ` +
        `Expected one of: ${APP_EDITIONS.join(", ")}.`,
    );
  }

  const edition: AppEdition = requested
    ? (requested as AppEdition)
    : locked
      ? (locked as AppEdition)
      : DEFAULT_EDITION;

  if (locked && edition !== locked) {
    throw new EditionConfigError(
      `This distribution is locked to the "${locked}" edition and cannot run ` +
        `as "${edition}". Build from the ${edition} edition repository instead ` +
        `of overriding APP_EDITION.`,
    );
  }

  return edition;
}
