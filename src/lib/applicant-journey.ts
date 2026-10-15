import type { ApplicationEntry, ApplicationRefusal } from "@/contracts/workforceApplication";

/**
 * The practitioner applicant's journey, derived only from what a server said. Each state is a claim about the account,
 * so each needs an answer that supports it:
 *
 * - The account states (unconfirmed, MFA incomplete) come from the applicant service reading the current Cognito
 *   account, never from the browser or an old token.
 * - The request states come from the applicant's own rows.
 * - "Clinical access available" needs three answers at once: the database says current membership would admit this
 *   account to that clinic now; this Desktop signs in by current clinic membership; and the clinic is among this
 *   session's own clinics. Any one missing is "approved, not yet authorized", with the reason that is missing.
 * - No answer at all is `unavailable` (no service to ask) or `failed` (the service did not answer). Neither is "no
 *   application": nobody is in a position to say that.
 */
export type ClinicSignIn = "current_membership" | "legacy_claims";
export type ApplicationAnswer =
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "refused"; code: ApplicationRefusal | string }
  | { kind: "answered"; entries: ApplicationEntry[]; clinicSignIn: ClinicSignIn; clinicIds: readonly string[] | null };

export type JourneyState =
  | { state: "signed_out" }
  | { state: "unavailable" }
  | { state: "failed" }
  | { state: "rate_limited" }
  | { state: "account_refused" }
  | { state: "account_unconfirmed" }
  | { state: "mfa_incomplete" }
  | { state: "not_submitted"; history: ApplicationEntry[] }
  | { state: "join_pending"; request: ApplicationEntry; history: ApplicationEntry[] }
  | { state: "proposal_pending"; request: ApplicationEntry; history: ApplicationEntry[] }
  | { state: "rejected"; request: ApplicationEntry; history: ApplicationEntry[] }
  | { state: "withdrawn"; request: ApplicationEntry; history: ApplicationEntry[] }
  | { state: "approved_not_authorized"; request: ApplicationEntry; reason: NotAuthorizedReason; history: ApplicationEntry[] }
  | { state: "clinical_access_available"; request: ApplicationEntry; history: ApplicationEntry[] };

export type NotAuthorizedReason =
  /** An approved new clinic, held until it is activated by a decision this app does not make. */
  | "clinic_activation_held"
  /** The database says current membership would not admit this account now (removed, suspended, clinic inactive). */
  | "membership_not_current"
  /** The service did not say whether access exists. */
  | "access_unknown"
  /** This Desktop still signs in by the legacy token claims, which an approval cannot change. */
  | "desktop_not_on_current_membership"
  /** The clinic is not among this session's clinics yet, or they could not be read. */
  | "clinic_not_in_session";

const newest = (entries: ApplicationEntry[]) => [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

export function journeyState(answer: ApplicationAnswer): JourneyState {
  switch (answer.kind) {
    case "signed_out": return { state: "signed_out" };
    case "unavailable": return { state: "unavailable" };
    case "failed": return { state: "failed" };
    case "refused":
      if (answer.code === "workforce_applicant_mfa_required") return { state: "mfa_incomplete" };
      if (answer.code === "workforce_applicant_email_unverified") return { state: "account_unconfirmed" };
      if (answer.code === "workforce_application_rate_limited") return { state: "rate_limited" };
      if (answer.code === "workforce_applicant_refused") return { state: "account_refused" };
      if (answer.code === "workforce_application_not_released") return { state: "unavailable" };
      return { state: "failed" };
  }
  const history = newest(answer.entries);
  const pending = history.find((entry) => entry.status === "pending");
  if (pending) return { state: pending.kind === "join" ? "join_pending" : "proposal_pending", request: pending, history };
  const approved = history.filter((entry) => entry.status === "approved");
  const usable = approved.find((entry) => entry.clinicalAccess === "available");
  if (usable) {
    if (answer.clinicSignIn !== "current_membership") return { state: "approved_not_authorized", request: usable, reason: "desktop_not_on_current_membership", history };
    if (!answer.clinicIds || !usable.organizationId || !answer.clinicIds.includes(usable.organizationId)) {
      return { state: "approved_not_authorized", request: usable, reason: "clinic_not_in_session", history };
    }
    return { state: "clinical_access_available", request: usable, history };
  }
  if (approved[0]) {
    const access = approved[0].clinicalAccess;
    const reason: NotAuthorizedReason = access === "held_for_clinic_activation" ? "clinic_activation_held"
      : access === "not_available" ? "membership_not_current" : "access_unknown";
    return { state: "approved_not_authorized", request: approved[0], reason, history };
  }
  const latest = history[0];
  if (latest?.status === "rejected") return { state: "rejected", request: latest, history };
  if (latest?.status === "withdrawn") return { state: "withdrawn", request: latest, history };
  return { state: "not_submitted", history };
}

/** Whether the applicant may start a new request from this state: never while one is pending or the account itself
 * is the problem. An approved practitioner may still ask to join another clinic. */
export function canSubmit(state: JourneyState): boolean {
  return ["not_submitted", "rejected", "withdrawn", "approved_not_authorized", "clinical_access_available"].includes(state.state);
}
