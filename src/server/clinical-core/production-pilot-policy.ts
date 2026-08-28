if (typeof window !== "undefined") {
  throw new Error("clinical-core/production-pilot-policy is server-only.");
}

import type { DesktopCompatibilityRequest } from "./aws-desktop-compatibility";
import type { ConsumerClinicalCollection } from "./aws-consumer-clinical-records";

export const PRODUCTION_PILOT_SCOPES = [
  "lab_intake_only",
  "lab_intake_wearables_cycle_ai",
] as const;
export type ProductionPilotScope = (typeof PRODUCTION_PILOT_SCOPES)[number];
export const PRODUCTION_PILOT_SCOPE: ProductionPilotScope = "lab_intake_only";

export const PRODUCTION_PILOT_ROUTE_KEYS = new Set([
  "GET /clinical-core/workforce/posture",
  "GET /clinical-core/consumer/posture",
  "POST /clinical-core/workforce/invitations",
  "POST /clinical-core/consumer/invitations/claim",
  "POST /clinical-core/workforce/consents/grant",
  "POST /clinical-core/consumer/consents/grant",
  "POST /clinical-core/workforce/consents/revoke",
  "POST /clinical-core/consumer/consents/revoke",
  "GET /clinical-core/consumer/consent-artifact",
  "GET /clinical-core/consumer/connection",
  "POST /clinical-core/consumer/labs/import",
  "GET /clinical-core/workforce/lab-imports",
  "POST /clinical-core/workforce/lab-imports/review",
  "GET /clinical-core/workforce/patient-labs",
  "GET /clinical-core/consumer/patient-labs",
  "POST /clinical-core/consumer/records",
  "GET /clinical-core/consumer/records",
  "GET /clinical-core/consumer/privacy/consents",
  "POST /clinical-core/consumer/privacy/requests",
  "GET /clinical-core/consumer/privacy/requests",
  "POST /clinical-core/workforce/data-compatibility",
]);

export const PRODUCTION_PILOT_DESKTOP_RPCS = new Set([
  "create_patient_profile",
  "review_biomarker",
  "list_patient_lab_observations",
  "record_registered_audit_event",
  "list_audit_events",
  "list_my_organizations",
  "activate_my_memberships",
  "create_review_task",
  "list_review_queue",
  "resolve_review_queue_item",
  "get_patient_overview",
  "get_patient_app_intake",
  "get_patient_sync_overview",
  "get_org_sync_operations",
  "create_sync_invitation",
  "pause_sync_connection",
  "resume_sync_connection",
  "revoke_sync_connection",
  "set_sync_consent_scope",
]);

export const PRODUCTION_PILOT_DESKTOP_SELECTS = new Set([
  "patient_profiles",
  "lab_documents",
]);

const LAB_INTAKE_COLLECTIONS = new Set<ConsumerClinicalCollection>([
  "wellness_profiles", "lifestyle_profiles", "contraindications", "questionnaire_responses", "clinical_intakes",
]);
const EXPANDED_COLLECTIONS = new Set<ConsumerClinicalCollection>([
  ...LAB_INTAKE_COLLECTIONS,
  "daily_adherence", "symptom_logs", "hormone_entries", "subjective_rollups", "weekly_checkins", "wearable_daily_records",
]);

export function isProductionPilotScope(scope: string): scope is ProductionPilotScope {
  return PRODUCTION_PILOT_SCOPES.includes(scope as ProductionPilotScope);
}

export function isProductionPilotRouteAllowed(routeKey: string | undefined): boolean {
  return typeof routeKey === "string" && PRODUCTION_PILOT_ROUTE_KEYS.has(routeKey);
}

export function isProductionPilotCollectionAllowed(scope: ProductionPilotScope, collection: ConsumerClinicalCollection): boolean {
  return (scope === "lab_intake_only" ? LAB_INTAKE_COLLECTIONS : EXPANDED_COLLECTIONS).has(collection);
}

export function isProductionPilotConsentScopeAllowed(scope: ProductionPilotScope, consentScope: string): boolean {
  const allowed = scope === "lab_intake_only"
    ? new Set(["forms_checkins", "lab_results_import"])
    : new Set(["forms_checkins", "symptoms_adherence", "wearables", "reproductive_health", "lab_results_import"]);
  return allowed.has(consentScope);
}

export function isProductionPilotDesktopRequestAllowed(request: DesktopCompatibilityRequest): boolean {
  return request.kind === "rpc"
    ? PRODUCTION_PILOT_DESKTOP_RPCS.has(request.functionName)
    : PRODUCTION_PILOT_DESKTOP_SELECTS.has(request.table);
}
