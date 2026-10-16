import type { BootstrapSuspensionReason, ClinicBootstrapState } from "@/contracts/workforceClinicBootstrap";
import type { ClinicSignIn, JourneyState } from "@/lib/applicant-journey";

/**
 * The "Create a new clinic" door of the applicant journey (workforce-clinic-bootstrap/1), derived only from what a
 * server said, beside the join and proposal states in src/lib/applicant-journey.ts.
 *
 * - `closed`: this Desktop or the service holds the door (`workforce_clinic_bootstrap_not_released`). That is a fact
 *   about the release, not about the account, and the held proposal stays the way to ask for a new clinic.
 * - `unknown`: nobody answered (no service, a failed read, signed out, a refusal). Never "no clinic".
 * - `none`: the service answered that this account has created no clinic.
 * - A created clinic is `ready` only when the database says it admits this account now, this Desktop signs in by
 *   current clinic membership, and the clinic is among this session's own clinics. Any one missing is
 *   `created_not_authorized` with the reason that is missing; `suspended` carries the operator's recorded reason.
 *
 * The browser never sends or decides a clinic, role, subject or assurance: the create request is a retry key and a
 * name (src/contracts/workforceClinicBootstrap.ts).
 */
export type BootstrapRead =
  | { kind: "not_released" }
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "refused"; code: string }
  | { kind: "answered"; clinic: ClinicBootstrapState | null; clinicSignIn: ClinicSignIn; inSession: boolean | null };

export type CreatedNotAuthorizedReason = "desktop_not_on_current_membership" | "clinic_not_in_session" | "membership_not_current";
export type NewClinicState =
  | { state: "closed" }
  | { state: "unknown" }
  | { state: "none" }
  | { state: "ready"; clinic: ClinicBootstrapState }
  | { state: "created_not_authorized"; clinic: ClinicBootstrapState; reason: CreatedNotAuthorizedReason }
  | { state: "suspended"; clinic: ClinicBootstrapState; reason: BootstrapSuspensionReason | null };

export function newClinicState(read: BootstrapRead): NewClinicState {
  if (read.kind === "not_released") return { state: "closed" };
  if (read.kind !== "answered") return { state: "unknown" };
  const clinic = read.clinic;
  if (!clinic) return { state: "none" };
  if (clinic.status === "suspended") return { state: "suspended", clinic, reason: clinic.suspensionReason };
  if (clinic.clinicalAccess !== "available") return { state: "created_not_authorized", clinic, reason: "membership_not_current" };
  if (read.clinicSignIn !== "current_membership") return { state: "created_not_authorized", clinic, reason: "desktop_not_on_current_membership" };
  if (read.inSession !== true) return { state: "created_not_authorized", clinic, reason: "clinic_not_in_session" };
  return { state: "ready", clinic };
}

/** A created clinic, whatever its state, is the account's one bootstrapped clinic: the door does not open again. */
export function hasCreatedClinic(state: NewClinicState): boolean {
  return state.state === "ready" || state.state === "created_not_authorized" || state.state === "suspended";
}

/**
 * Whether the create form may be offered: the door is open, the service answered "no clinic yet", and the application
 * service agrees the account itself is fine (signed in, address confirmed, MFA set up). A pending new-clinic proposal
 * blocks it, as the service would; a pending join request does not.
 */
export function canCreateClinic(newClinic: NewClinicState, application: JourneyState): boolean {
  if (newClinic.state !== "none") return false;
  return ["not_submitted", "join_pending", "rejected", "withdrawn", "approved_not_authorized", "clinical_access_available"].includes(application.state);
}

/**
 * The held proposal (reviewed by the platform team, grants nothing by itself) is offered for a new clinic only where
 * the create door cannot serve this account: the door is closed here, or this account already created its one clinic.
 */
export function canProposeClinic(newClinic: NewClinicState): boolean {
  return newClinic.state === "closed" || hasCreatedClinic(newClinic);
}

/**
 * What one create attempt's reply means. `keep` says whether the same request id must be kept for a resend: only when
 * the clinic may have been created without a confirmed answer (a lost or unconfirmed reply) or nothing was processed
 * (rate limited). A definite answer, and any refusal that names this account's state, ends the attempt.
 */
export type CreateOutcome = {
  kind: "created" | "already_created" | "lost" | "closed" | "exists" | "conflict" | "proposal_pending" | "mfa" | "email"
    | "refused" | "rate_limited" | "invalid" | "signed_out" | "cross_site" | "not_configured";
  keep: boolean;
};
export function createOutcome(reply: { status: number; error?: unknown; duplicate?: unknown } | "no_answer"): CreateOutcome {
  if (reply === "no_answer") return { kind: "lost", keep: true };
  const { status, error } = reply;
  if (status === 201) return { kind: "created", keep: false };
  if (status === 200) return { kind: reply.duplicate === true ? "already_created" : "created", keep: false };
  if (error === "workforce_clinic_bootstrap_not_released") return { kind: "closed", keep: false };
  if (error === "workforce_clinic_bootstrap_exists") return { kind: "exists", keep: false };
  if (error === "workforce_clinic_bootstrap_conflict") return { kind: "conflict", keep: false };
  if (error === "workforce_application_already_pending") return { kind: "proposal_pending", keep: false };
  if (error === "workforce_applicant_mfa_required") return { kind: "mfa", keep: false };
  if (error === "workforce_applicant_email_unverified") return { kind: "email", keep: false };
  if (error === "workforce_applicant_refused") return { kind: "refused", keep: false };
  if (error === "workforce_application_rate_limited") return { kind: "rate_limited", keep: true };
  if (error === "request_invalid") return { kind: "invalid", keep: false };
  if (error === "reauth_required") return { kind: "signed_out", keep: false };
  if (error === "identity_refused") return { kind: "cross_site", keep: false };
  if (error === "application_service_not_configured") return { kind: "not_configured", keep: false };
  // Anything else, including a reply the route could not confirm as this request's: the clinic may exist.
  return { kind: "lost", keep: true };
}
