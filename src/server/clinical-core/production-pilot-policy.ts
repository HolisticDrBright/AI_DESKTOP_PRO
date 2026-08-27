if (typeof window !== "undefined") {
  throw new Error("clinical-core/production-pilot-policy is server-only.");
}

import type { DesktopCompatibilityRequest } from "./aws-desktop-compatibility";

export const PRODUCTION_PILOT_SCOPE = "lab_intake_only" as const;

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

export function isProductionPilotRouteAllowed(routeKey: string | undefined): boolean {
  return typeof routeKey === "string" && PRODUCTION_PILOT_ROUTE_KEYS.has(routeKey);
}

export function isProductionPilotDesktopRequestAllowed(request: DesktopCompatibilityRequest): boolean {
  return request.kind === "rpc"
    ? PRODUCTION_PILOT_DESKTOP_RPCS.has(request.functionName)
    : PRODUCTION_PILOT_DESKTOP_SELECTS.has(request.table);
}
