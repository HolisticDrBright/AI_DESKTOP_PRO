import { describe, expect, test } from "vitest";
import {
  CLINICAL_CORE_CONTRACT_VERSION,
  evaluateClinicalCorePosture,
  isPatientObservationEnvelope,
  RESOURCE_AUTHORITY,
} from "./authority";

describe("AWS clinical-core foundation", () => {
  test("a deployment cannot treat Supabase staging as production", () => {
    expect(evaluateClinicalCorePosture({
      dataPlane: "supabase_staging",
      deployment: true,
    })).toEqual({
      available: false,
      dataPlane: "supabase_staging",
      reason: "supabase_is_staging_only",
    });
  });

  test("AWS is unavailable until both region and HTTPS API origin exist", () => {
    expect(evaluateClinicalCorePosture({ dataPlane: "aws", deployment: true }))
      .toMatchObject({ available: false, reason: "aws_region_missing" });
    expect(evaluateClinicalCorePosture({
      dataPlane: "aws",
      deployment: true,
      awsRegion: "us-east-2",
      apiOrigin: "http://clinical.example",
    })).toMatchObject({ available: false, reason: "aws_api_origin_invalid" });
    expect(evaluateClinicalCorePosture({
      dataPlane: "aws",
      deployment: true,
      awsRegion: "us-east-2",
      apiOrigin: "https://unexpected.example",
      allowedApiHosts: ["api.clinical.example"],
    })).toMatchObject({ available: false, reason: "aws_api_origin_unapproved" });
    expect(evaluateClinicalCorePosture({
      dataPlane: "aws",
      deployment: true,
      awsRegion: "us-east-2",
      apiOrigin: "https://api.clinical.example",
      allowedApiHosts: ["api.clinical.example"],
    })).toEqual({ available: true, dataPlane: "aws" });
  });

  test("patient observations remain reviewable rather than becoming chart facts", () => {
    expect(RESOURCE_AUTHORITY.patient_wearable_observation)
      .toBe("v2_until_practitioner_acceptance");
    expect(isPatientObservationEnvelope({
      contractVersion: CLINICAL_CORE_CONTRACT_VERSION,
      observationId: "obs-1",
      patientId: "patient-1",
      kind: "wearable",
      source: "junction",
      observedAt: "2026-08-11T10:00:00Z",
      receivedAt: "2026-08-11T10:01:00Z",
      provenanceHash: "sha256:test",
      reviewState: "awaiting_practitioner",
    })).toBe(true);
  });
});
