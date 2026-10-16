if (typeof window !== "undefined") throw new Error("Fullscript clinic authority is server-only.");

import { AdapterError, isAdapterError } from "@/adapters/errors";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { clinicalAuthorityMode } from "@/adapters/selected-clinic.server";
import { clinicChoices } from "@/server/clinic-choices";
import { getRequestSelectedClinic } from "@/server/request-clinic";
import type { RequestSession } from "@/server/session";

/**
 * The Fullscript routes' own clinic check.
 *
 * A Fullscript connection is stored per practitioner per clinic, under the session's clinic. That clinic is the
 * session's selection, which is never authority (src/adapters/selected-clinic.server.ts): a membership can be removed,
 * or a clinic suspended, after the cookie was written. So before any Fullscript work — reading the connection, calling
 * Fullscript, revoking, starting or completing an authorization — the account's current clinics are read again and
 * the session's clinic must be among them:
 *
 * - under `legacy_claims`, `list_my_organizations`, which lists only active memberships in active clinics;
 * - under `database_current`, the subject-only discovery, and the selection must also be the one bound to this
 *   account's token.
 *
 * The connection is also keyed by the practitioner's email, and the session's email is the display cookie written at
 * sign-in. A cookie is the browser's to edit, so the email must be the one in the ID token, whose signature the
 * clinical API verifies in the same request when it answers the clinic read. Otherwise one member could reach a
 * colleague's Fullscript connection by editing a cookie.
 *
 * A read that fails refuses as unavailable and never falls back to the cookie. A refusal names no clinic, subject or
 * reason, so it does not say whether the clinic exists.
 */
export const FULLSCRIPT_CLINIC_REFUSED = "Fullscript isn't available for this clinic on this account.";
export const FULLSCRIPT_CLINIC_UNVERIFIED = "Your clinic access couldn't be confirmed right now, so Fullscript is unavailable. Try again.";

export async function currentFullscriptSession(session: RequestSession): Promise<RequestSession> {
  if (!session.signedIn || session.expired || !session.token) throw new AdapterError("unauthenticated");
  if (!session.orgId) throw new AdapterError("forbidden", FULLSCRIPT_CLINIC_REFUSED, "fullscript_no_clinic");
  const email = tokenEmail(session.token);
  if (!email || email !== session.email?.toLowerCase()) {
    throw new AdapterError("forbidden", FULLSCRIPT_CLINIC_REFUSED, "fullscript_email_not_token");
  }
  const clinic = session.orgId;
  if (clinicalAuthorityMode() === "database_current") {
    const selection = await getRequestSelectedClinic();
    if (selection.state !== "selected" || selection.organizationId !== clinic) {
      throw new AdapterError("forbidden", FULLSCRIPT_CLINIC_REFUSED, `fullscript_selection_${selection.state}`);
    }
  }
  let current: string[];
  try {
    current = (await clinicChoices(await getClinicalAccessToken(session.token))).clinics
      .map((choice) => choice.organizationId).filter((id): id is string => typeof id === "string");
  } catch (error) {
    if (isAdapterError(error) && error.code === "unauthenticated") throw new AdapterError("unauthenticated");
    if (isAdapterError(error) && error.code === "forbidden") {
      throw new AdapterError("forbidden", FULLSCRIPT_CLINIC_REFUSED, "fullscript_clinics_refused");
    }
    throw new AdapterError("unavailable", FULLSCRIPT_CLINIC_UNVERIFIED, "fullscript_clinics_unread");
  }
  if (!current.includes(clinic)) throw new AdapterError("forbidden", FULLSCRIPT_CLINIC_REFUSED, "fullscript_clinic_not_current");
  return session;
}

/** The lower-case `email` claim of a session ID token, or null. Decoding only: the clinical API checks the signature. */
function tokenEmail(idToken: string): string | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return null;
  try {
    const email = (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { email?: unknown }).email;
    return typeof email === "string" && email.includes("@") ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}
