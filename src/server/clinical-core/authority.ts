export const CLINICAL_CORE_CONTRACT_VERSION = "clinical-core/1" as const;

export type ClinicalCoreDataPlane = "supabase_staging" | "aws";
export type ClinicalCoreResource =
  | "patient_identity"
  | "consent"
  | "clinical_chart"
  | "practitioner_protocol"
  | "patient_nutrition_observation"
  | "patient_wearable_observation"
  | "adherence_check_in"
  | "billing"
  | "commercial_catalog";

export const RESOURCE_AUTHORITY: Record<ClinicalCoreResource, string> = {
  patient_identity: "clinical_core",
  consent: "clinical_core",
  clinical_chart: "desktop",
  practitioner_protocol: "desktop",
  patient_nutrition_observation: "v2_until_practitioner_acceptance",
  patient_wearable_observation: "v2_until_practitioner_acceptance",
  adherence_check_in: "v2_until_practitioner_acceptance",
  billing: "desktop",
  commercial_catalog: "separate_from_clinical_ranking",
};

export interface ClinicalCoreRuntimeInput {
  dataPlane?: string;
  deployment?: boolean;
  awsRegion?: string;
  apiOrigin?: string;
  allowedApiHosts?: readonly string[];
}

export type ClinicalCorePosture =
  | { available: true; dataPlane: ClinicalCoreDataPlane }
  | {
      available: false;
      dataPlane: ClinicalCoreDataPlane | "unknown";
      reason:
        | "data_plane_not_declared"
        | "supabase_is_staging_only"
        | "aws_region_missing"
        | "aws_api_origin_invalid"
        | "aws_api_origin_unapproved";
    };

export function evaluateClinicalCorePosture(input: ClinicalCoreRuntimeInput): ClinicalCorePosture {
  if (input.dataPlane !== "supabase_staging" && input.dataPlane !== "aws") {
    return { available: false, dataPlane: "unknown", reason: "data_plane_not_declared" };
  }
  if (input.dataPlane === "supabase_staging") {
    return input.deployment
      ? { available: false, dataPlane: input.dataPlane, reason: "supabase_is_staging_only" }
      : { available: true, dataPlane: input.dataPlane };
  }
  if (!input.awsRegion) {
    return { available: false, dataPlane: "aws", reason: "aws_region_missing" };
  }
  try {
    const api = new URL(input.apiOrigin ?? "");
    if (api.protocol !== "https:") throw new Error("protocol");
    if (!input.allowedApiHosts?.includes(api.hostname)) {
      return { available: false, dataPlane: "aws", reason: "aws_api_origin_unapproved" };
    }
  } catch {
    return { available: false, dataPlane: "aws", reason: "aws_api_origin_invalid" };
  }
  return { available: true, dataPlane: "aws" };
}

export function evaluateClinicalCoreEnvironment(deployment: boolean): ClinicalCorePosture {
  return evaluateClinicalCorePosture({
    dataPlane: process.env.CLINICAL_DATA_PLANE,
    deployment,
    awsRegion: process.env.CLINICAL_AWS_REGION,
    apiOrigin: process.env.CLINICAL_AWS_API_ORIGIN,
    allowedApiHosts: (process.env.CLINICAL_AWS_ALLOWED_API_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  });
}

export type ObservationKind = "nutrition" | "wearable" | "adherence";

export interface PatientObservationEnvelope {
  contractVersion: typeof CLINICAL_CORE_CONTRACT_VERSION;
  observationId: string;
  patientId: string;
  kind: ObservationKind;
  source: "junction" | "passio" | "patient_entry";
  observedAt: string;
  receivedAt: string;
  provenanceHash: string;
  reviewState: "awaiting_practitioner";
}

export function isPatientObservationEnvelope(value: unknown): value is PatientObservationEnvelope {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PatientObservationEnvelope>;
  return item.contractVersion === CLINICAL_CORE_CONTRACT_VERSION
    && typeof item.observationId === "string"
    && typeof item.patientId === "string"
    && ["nutrition", "wearable", "adherence"].includes(item.kind ?? "")
    && ["junction", "passio", "patient_entry"].includes(item.source ?? "")
    && typeof item.observedAt === "string"
    && typeof item.receivedAt === "string"
    && typeof item.provenanceHash === "string"
    && item.reviewState === "awaiting_practitioner";
}
