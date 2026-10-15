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
  patient_notification_settings: "/clinical-core/workforce/notifications/settings",
  ask_alp_workforce: "/clinical-core/workforce/chat",
  privacy_operations: "/clinical-core/workforce/privacy-operations",
  lab_attestation: "/clinical-core/workforce/lab-attestations and /lab-attestations/review",
  consult_workforce: "/clinical-core/workforce consult links, requests, records, retention, disputes, outcomes, carts, note templates, intake",
  /** Found by the caller scan beside the ten: the synthetic boundary's posture and invitations, claims-based by design. */
  synthetic_boundary: "/clinical-core/{workforce,consumer}/posture and /clinical-core/workforce/invitations on the synthetic API",
} as const;
export type UnconvertedClinicFamily = keyof typeof UNCONVERTED_CLINIC_FAMILIES;

/**
 * Converted in source on both sides, and still refused unless the deployment says its service serves them.
 *
 * Each service has a `database_current` path that binds the current membership of the signed-in subject in the one
 * selected clinic inside the operation's own transaction (the UNREGISTERED current-membership setter), and each caller
 * sends only the session's own selection (`x-alp-selected-organization-id`) behind the stale-tab fence. But whether the
 * service this Desktop reaches runs that path is a deployment fact the Desktop cannot see from a token, so each family
 * stays refused, exactly as before, until `CLINICAL_CURRENT_MEMBERSHIP_FAMILIES` names it: a pairing with the service's
 * own `database_current` configuration, decided together and never to clear an error. Even then an answer is accepted
 * only when it names the selected clinic it was decided in; any other answer is the same refusal.
 */
export const CURRENT_MEMBERSHIP_GATED_FAMILIES = {
  care_messages: "/clinical-core/workforce/messages (production care messaging API, CARE_MESSAGING_WORKFORCE_AUTHORITY=database_current)",
  program_assignments: "/clinical-core/workforce/programs (production program family; no deployed host serves it under database_current yet)",
} as const;
export type GatedClinicFamily = keyof typeof CURRENT_MEMBERSHIP_GATED_FAMILIES;

/** The gated families this deployment pairs with a `database_current` service. Anything unrecognised names none. */
export function servedCurrentMembershipFamilies(): ReadonlySet<GatedClinicFamily> {
  const raw = process.env.CLINICAL_CURRENT_MEMBERSHIP_FAMILIES ?? "";
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.some((name) => !Object.hasOwn(CURRENT_MEMBERSHIP_GATED_FAMILIES, name))) return new Set();
  return new Set(names as GatedClinicFamily[]);
}

/**
 * Not clinical authority at all, so not converted and not refused: the campaign engine has its own API and authorizer,
 * imports nothing clinical, and never names or reads a clinic selection.
 */
export const INDEPENDENT_FAMILIES = { campaign_api: "the campaign engine's own API (CAMPAIGN_API_ORIGIN)" } as const;

/** The machine word for the refusal, the same one the identity API answers for an unconverted workforce route. */
export const CLINIC_MEMBERSHIP_REFUSAL = "membership_authority_not_configured";
export const CLINIC_MEMBERSHIP_REFUSAL_MESSAGE = "This is not available yet under clinic-membership sign-in.";

/**
 * True when `family` must refuse before any request: the session runs under `database_current`, and the family is
 * unconverted, or gated and not paired with a `database_current` service by this deployment.
 */
export function refusedUnderClinicMembership(family: UnconvertedClinicFamily | GatedClinicFamily): boolean {
  if (clinicalAuthorityMode() !== "database_current") return false;
  if (Object.hasOwn(CURRENT_MEMBERSHIP_GATED_FAMILIES, family)) return !servedCurrentMembershipFamilies().has(family as GatedClinicFamily);
  void UNCONVERTED_CLINIC_FAMILIES[family as UnconvertedClinicFamily];
  return true;
}
