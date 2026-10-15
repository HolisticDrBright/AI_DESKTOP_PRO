if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { AdapterError } from "./errors";

/**
 * The clinic a Desktop request runs in, under the `database_current` workforce authority.
 *
 * The AWS identity API resolves the person and their role from current membership rows for the signed-in subject and
 * exactly one selected clinic (`x-alp-selected-organization-id`). This module decides which clinic that header names:
 *
 * - **Only the authenticated session's own selection.** It is the httpOnly `aidp_org` cookie, written after a server
 *   membership check, plus `aidp_org_sub`, a digest of the Cognito `sub` of the account that made the choice. A form,
 *   URL, request body, module-level variable or Cognito custom claim is never a source.
 * - **Bound to the token being sent.** A selection made by another account (an account switch without signing out) is
 *   refused, not reused.
 * - **One per request.** The selection travels in a request-scoped AsyncLocalStorage context set by the live-route
 *   helper, so two requests in one server process (two tabs, two people) never see each other's choice.
 *
 * The selection is not authority: the API decides membership from current rows. It only picks which clinic is asked.
 * Under the default `legacy_claims` mode, none of this is used and requests are unchanged.
 */
export const SELECTED_CLINIC_HEADER = "x-alp-selected-organization-id";
const BINDING_DOMAIN = "aidp-selected-clinic/1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClinicalAuthorityMode = "legacy_claims" | "database_current";

/** Server configuration only. Unset or anything else is the legacy default. */
export function clinicalAuthorityMode(): ClinicalAuthorityMode {
  return process.env.CLINICAL_WORKFORCE_AUTHORITY_MODE === "database_current" ? "database_current" : "legacy_claims";
}

export type SelectedClinic =
  | { state: "selected"; organizationId: string; binding: string }
  | { state: "missing" | "malformed" | "duplicate" | "unbound" | "account_mismatch" };

/** The binding for one Cognito subject, read from the session's own ID token. Null when the token carries no UUID `sub`. */
export function subjectBinding(idToken: string | null | undefined): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let sub: unknown;
  try {
    sub = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { sub?: unknown }).sub;
  } catch {
    return null;
  }
  if (typeof sub !== "string" || !UUID.test(sub)) return null;
  return createHash("sha256").update(`${BINDING_DOMAIN}|${sub.toLowerCase()}`).digest("hex");
}

/**
 * Decide the session's selection from every `aidp_org` and `aidp_org_sub` value the request carried and the token it
 * will present. Two values for either cookie are ambiguous and refused.
 */
export function resolveSelectedClinic(input: {
  organizationCookies: readonly string[];
  bindingCookies: readonly string[];
  token: string | null | undefined;
}): SelectedClinic {
  const organizations = input.organizationCookies.filter((value) => value !== "");
  const bindings = input.bindingCookies.filter((value) => value !== "");
  if (organizations.length === 0) return { state: "missing" };
  if (organizations.length > 1 || bindings.length > 1) return { state: "duplicate" };
  const organizationId = organizations[0]!;
  if (!UUID.test(organizationId)) return { state: "malformed" };
  if (bindings.length === 0 || !/^[0-9a-f]{64}$/.test(bindings[0]!)) return { state: "unbound" };
  const binding = subjectBinding(input.token);
  if (!binding || binding !== bindings[0]) return { state: "account_mismatch" };
  return { state: "selected", organizationId: organizationId.toLowerCase(), binding };
}

/** The two cookie values that record a selection for the account holding `idToken`; null when it cannot be bound. */
export function selectedClinicCookieValues(organizationId: string, idToken: string): { organization: string; binding: string } | null {
  const binding = subjectBinding(idToken);
  if (!UUID.test(organizationId) || !binding) return null;
  return { organization: organizationId.toLowerCase(), binding };
}

const requestSelection = new AsyncLocalStorage<{ selection: SelectedClinic }>();

/** Run one request's work with the selection its session resolved. Nothing outlives the call. */
export function withSelectedClinic<T>(selection: SelectedClinic | undefined, work: () => Promise<T>): Promise<T> {
  return requestSelection.run({ selection: selection ?? { state: "missing" } }, work);
}

/** The selection of the request in progress, or null outside any live request. */
export function currentSelectedClinic(): SelectedClinic | null {
  return requestSelection.getStore()?.selection ?? null;
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
  if (selection.binding !== subjectBinding(token)) {
    throw new AdapterError("invalid", "Choose your clinic in Settings before continuing.", "clinic_selection_account_mismatch");
  }
  if (organizationHint !== null && organizationHint.toLowerCase() !== selection.organizationId) {
    throw new AdapterError("conflict", "Your clinic changed in another window. Reload to continue.", "clinic_selection_changed");
  }
  return { [SELECTED_CLINIC_HEADER]: selection.organizationId };
}
