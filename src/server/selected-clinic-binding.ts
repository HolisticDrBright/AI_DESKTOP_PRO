import { createHash } from "node:crypto";
import { SELECTED_CLINIC_UUID, tokenSubject, type SelectedClinic } from "@/adapters/selected-clinic.server";

/**
 * The cookie side of the selected clinic (see `src/adapters/selected-clinic.server.ts`): `aidp_org_sub` holds
 * `sha256("aidp-selected-clinic/1|" + sub)` for the Cognito subject that made the choice, never the subject itself.
 * Server routes and server components only; the client build never reaches this module.
 */
const BINDING_DOMAIN = "aidp-selected-clinic/1";

/** The binding for one Cognito subject, read from the session's own ID token. Null when the token carries no UUID `sub`. */
export function subjectBinding(idToken: string | null | undefined): string | null {
  const subject = tokenSubject(idToken);
  return subject ? createHash("sha256").update(`${BINDING_DOMAIN}|${subject}`).digest("hex") : null;
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
  if (!SELECTED_CLINIC_UUID.test(organizationId)) return { state: "malformed" };
  if (bindings.length === 0 || !/^[0-9a-f]{64}$/.test(bindings[0]!)) return { state: "unbound" };
  const subject = tokenSubject(input.token);
  if (!subject || subjectBinding(input.token) !== bindings[0]) return { state: "account_mismatch" };
  return { state: "selected", organizationId: organizationId.toLowerCase(), subject };
}

/** The two cookie values that record a selection for the account holding `idToken`, with its subject; null when unbindable. */
export function selectedClinicCookieValues(organizationId: string, idToken: string):
  { organization: string; binding: string; subject: string } | null {
  const subject = tokenSubject(idToken);
  const binding = subjectBinding(idToken);
  if (!SELECTED_CLINIC_UUID.test(organizationId) || !subject || !binding) return null;
  return { organization: organizationId.toLowerCase(), binding, subject };
}

/**
 * The tab-facing fingerprint of one selection: which account and which clinic a page or response was produced under.
 * It is not a credential and grants nothing; the server only compares it with the token of the session's current,
 * account-bound selection, so a tab rendered for another clinic or another account is refused.
 */
export function clinicBindingToken(selection: Extract<SelectedClinic, { state: "selected" }>): string {
  return "v1." + createHash("sha256")
    .update(`aidp-expected-clinic/1|${selection.subject}|${selection.organizationId}`).digest("base64url").slice(0, 32);
}
