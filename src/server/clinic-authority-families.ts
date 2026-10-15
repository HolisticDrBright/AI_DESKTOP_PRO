import { clinicalAuthorityMode } from "@/adapters/selected-clinic.server";

/**
 * The Desktop caller families that reach an AWS service with the practitioner's token but are not converted to the
 * `database_current` authority, where the session's selected clinic is the clinic and a token claim is not.
 *
 * Each of these services still decides the clinic from the token's custom claims (the encounter-recording APIs, care
 * messaging, privacy operations), or is an identity-API route that the current authority does not serve yet. A request
 * from a `database_current` session could therefore act in the clinic its token names rather than the one selected, or
 * reach a route that can only refuse. So each caller refuses first, before any token leaves this process. Converting
 * a family means converting the service and its caller together; switching a caller on to clear an error does not.
 *
 * Under the legacy default nothing here changes.
 */
export const UNCONVERTED_CLINIC_FAMILIES = {
  encounter_recording: "/clinical-core/workforce/encounter-recording/* (authority, capture, drafting, transcription, cleanup review, cleanup execution)",
  calendar_connection: "/clinical-core/workforce/calendar-connection",
  care_messages: "/clinical-core/workforce/messages",
  patient_notification_settings: "/clinical-core/workforce/notifications/settings",
  program_assignments: "/clinical-core/workforce/programs",
  ask_alp_workforce: "/clinical-core/workforce/chat",
  privacy_operations: "/clinical-core/workforce/privacy-operations",
  lab_attestation: "/clinical-core/workforce/lab-attestations and /lab-attestations/review",
  consult_workforce: "/clinical-core/workforce consult links, requests, records, retention, disputes, outcomes, carts, note templates, intake",
  /** Found by the caller scan beside the ten: the synthetic boundary's posture and invitations, claims-based by design. */
  synthetic_boundary: "/clinical-core/{workforce,consumer}/posture and /clinical-core/workforce/invitations on the synthetic API",
} as const;
export type UnconvertedClinicFamily = keyof typeof UNCONVERTED_CLINIC_FAMILIES;

/**
 * Not clinical authority at all, so not converted and not refused: the campaign engine has its own API and authorizer,
 * imports nothing clinical, and never names or reads a clinic selection.
 */
export const INDEPENDENT_FAMILIES = { campaign_api: "the campaign engine's own API (CAMPAIGN_API_ORIGIN)" } as const;

/** The machine word for the refusal, the same one the identity API answers for an unconverted workforce route. */
export const CLINIC_MEMBERSHIP_REFUSAL = "membership_authority_not_configured";
export const CLINIC_MEMBERSHIP_REFUSAL_MESSAGE = "This is not available yet under clinic-membership sign-in.";

/** True when `family` must refuse before any request: the session runs under `database_current`. */
export function refusedUnderClinicMembership(family: UnconvertedClinicFamily): boolean {
  void UNCONVERTED_CLINIC_FAMILIES[family];
  return clinicalAuthorityMode() === "database_current";
}
