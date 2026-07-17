/**
 * Adapter error model (client-safe).
 *
 * Every failure the UI can see is normalized to an `AdapterError` with a
 * stable `code` and a clinician-safe `message`. The message is deliberately
 * generic — it never carries PHI, raw backend payloads, tokens, SQL, or stack
 * detail. Anything sensitive stays in `detail`, which is for server logs only
 * and is never rendered.
 *
 * This module has NO server imports, so it is safe in both client and server
 * bundles.
 */

export type AdapterErrorCode =
  | "unauthenticated" // no/expired session
  | "forbidden" // authenticated but not allowed (RLS / access gate)
  | "not_found" // no such resource, or not visible to this user
  | "invalid" // bad input / failed validation
  | "conflict" // optimistic-concurrency clash (record changed elsewhere)
  | "unavailable" // backend unreachable / not configured / timeout
  | "unknown";

/** Clinician-safe default messages. Intentionally free of PHI and internals. */
const DEFAULT_MESSAGE: Record<AdapterErrorCode, string> = {
  unauthenticated: "Your session has expired. Sign in again to continue.",
  forbidden: "You don't have access to this record.",
  not_found: "This record isn't available.",
  invalid: "That action couldn't be completed as requested.",
  conflict: "This record changed in another tab or session. Review the latest version before saving again.",
  unavailable: "The clinical service is unavailable right now. Please try again.",
  unknown: "Something went wrong. Please try again.",
};

/** Map an adapter code to an HTTP status for route handlers. */
export const HTTP_STATUS: Record<AdapterErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  unavailable: 503,
  unknown: 500,
};

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  /** Server-only diagnostic context. Never shown to the user. */
  readonly detail?: string;

  constructor(code: AdapterErrorCode, message?: string, detail?: string) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail;
  }

  /** The safe, user-facing string. Alias kept explicit for call sites. */
  get safeMessage(): string {
    return this.message;
  }

  toJSON() {
    // Only code + safe message cross the wire. `detail` is intentionally omitted.
    return { error: { code: this.code, message: this.message } };
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}

/** Map an HTTP status (e.g. from a tRPC/PostgREST response) to a code. */
export function codeFromHttpStatus(status: number): AdapterErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid";
  if (status === 503 || status === 502 || status === 504) return "unavailable";
  return "unknown";
}

/**
 * Normalize anything thrown into an AdapterError with a safe message. The
 * original message is preserved as `detail` (server logs) but never surfaced.
 */
export function toAdapterError(e: unknown, fallback: AdapterErrorCode = "unknown"): AdapterError {
  if (e instanceof AdapterError) return e;
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : undefined;
  return new AdapterError(fallback, DEFAULT_MESSAGE[fallback], detail);
}
