if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { AdapterError } from "./errors";

/**
 * The clinic a Desktop request runs in, under the `database_current` workforce authority.
 *
 * The AWS identity API resolves the person and their role from current membership rows for the signed-in subject and
 * exactly one selected clinic (`x-alp-selected-organization-id`). This module decides which clinic that header names:
 *
 * - **Only the authenticated session's own selection.** It is the httpOnly `aidp_org` cookie, written after a server
 *   membership check, plus `aidp_org_sub`, a digest of the Cognito `sub` of the account that made the choice
 *   (`src/server/selected-clinic-binding.ts` checks it). A form, URL, request body, module-level variable or Cognito
 *   custom claim is never a source.
 * - **Bound to the token being sent.** A selection made by another account (an account switch without signing out) is
 *   refused, not reused.
 * - **One per request.** The selection travels in a request-scoped AsyncLocalStorage context set by the live-route
 *   helper, so two requests in one server process (two tabs, two people) never see each other's choice.
 *
 * The selection is not authority: the API decides membership from current rows. It only picks which clinic is asked.
 * Under the default `legacy_claims` mode, none of this is used and requests are unchanged.
 *
 * The client build compiles this module (the clinical transport sits behind a dynamic import in the adapter index), so
 * it imports no Node built-in: the request context comes from the runtime's own AsyncLocalStorage, and the subject check
 * decodes the token without hashing.
 */
export const SELECTED_CLINIC_HEADER = "x-alp-selected-organization-id";
export const SELECTED_CLINIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClinicalAuthorityMode = "legacy_claims" | "database_current";

/** Server configuration only. Unset or anything else is the legacy default. */
export function clinicalAuthorityMode(): ClinicalAuthorityMode {
  return process.env.CLINICAL_WORKFORCE_AUTHORITY_MODE === "database_current" ? "database_current" : "legacy_claims";
}

/** `subject` is the lower-case Cognito `sub` the selection was bound to; it lives in the request context only. */
export type SelectedClinic =
  | { state: "selected"; organizationId: string; subject: string }
  | { state: "missing" | "malformed" | "duplicate" | "unbound" | "account_mismatch" };

/** The UUID `sub` of a session ID token, lower-cased, or null. Decoding only: the token's signature is the API's to check. */
export function tokenSubject(idToken: string | null | undefined): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  let sub: unknown;
  try {
    const base64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    sub = (JSON.parse(json) as { sub?: unknown }).sub;
  } catch {
    return null;
  }
  return typeof sub === "string" && SELECTED_CLINIC_UUID.test(sub) ? sub.toLowerCase() : null;
}

type Store = { selection: SelectedClinic };
type Storage = { run<R>(store: Store, work: () => R): R; getStore(): Store | undefined };
type StorageClass = new () => Storage;
/**
 * Next.js puts AsyncLocalStorage on `globalThis` in its Node server before any route module loads; plain Node (tests,
 * scripts) provides it through `process.getBuiltinModule`. Where neither exists there is no request context, and every
 * `database_current` request refuses.
 */
function createStorage(): Storage | null {
  const fromGlobal = (globalThis as { AsyncLocalStorage?: StorageClass }).AsyncLocalStorage;
  const builtin = (process as { getBuiltinModule?: (id: string) => { AsyncLocalStorage?: StorageClass } | undefined })
    .getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage;
  const Constructor = typeof fromGlobal === "function" ? fromGlobal : builtin;
  return typeof Constructor === "function" ? new Constructor() : null;
}
const requestSelection = createStorage();

/** Run one request's work with the selection its session resolved. Nothing outlives the call. */
export function withSelectedClinic<T>(selection: SelectedClinic | undefined, work: () => Promise<T>): Promise<T> {
  if (!requestSelection) return work();
  return requestSelection.run({ selection: selection ?? { state: "missing" } }, work);
}

/** The selection of the request in progress, or null outside any live request. */
export function currentSelectedClinic(): SelectedClinic | null {
  return requestSelection?.getStore()?.selection ?? null;
}

/**
 * Under `database_current`, the one `x-alp-selected-organization-id` header for this request: the session's own
 * selection, bound to the token being sent. Anything else refuses here, before a request leaves the server. A clinic
 * an operation names itself must be that same clinic, so work prepared under one selection cannot run under another
 * (a second tab that switched clinics). Under the legacy default it adds nothing.
 */
export function selectedClinicHeaders(token: string, organizationHint: string | null): Record<string, string> {
  if (clinicalAuthorityMode() !== "database_current") return {};
  const selection = currentSelectedClinic();
  if (!selection || selection.state !== "selected") {
    throw new AdapterError("invalid", "Choose your clinic in Settings before continuing.",
      `clinic_selection_${selection?.state ?? "unavailable"}`);
  }
  if (selection.subject !== tokenSubject(token)) {
    throw new AdapterError("invalid", "Choose your clinic in Settings before continuing.", "clinic_selection_account_mismatch");
  }
  if (organizationHint !== null && organizationHint.toLowerCase() !== selection.organizationId) {
    throw new AdapterError("conflict", "Your clinic changed in another window. Reload to continue.", "clinic_selection_changed");
  }
  return { [SELECTED_CLINIC_HEADER]: selection.organizationId };
}
