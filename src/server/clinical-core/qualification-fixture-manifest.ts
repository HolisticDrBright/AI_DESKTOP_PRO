import { readFileSync } from "node:fs";
import { SyntheticFixtureError, validateSyntheticAcceptanceManifest, type SyntheticAcceptanceManifest } from "./synthetic-fixtures";

/** Version 2 tests cross-owner isolation with two consumers, not two practitioners.
 * The second consumer receives no clinic membership or patient connection. */
export type QualificationConsumerFixtureManifest = Omit<SyntheticAcceptanceManifest, "schemaVersion" | "fixture"> & {
  schemaVersion: "aws-clinical-core-qualification-fixtures/2";
  fixture: Omit<SyntheticAcceptanceManifest["fixture"], "isolationWorkforcePersonId" | "isolationWorkforceSubject"> & {
    isolationConsumerPersonId: string;
    isolationConsumerSubject: string;
  };
};
export type QualificationFixtureManifest = SyntheticAcceptanceManifest | QualificationConsumerFixtureManifest;

export function validateQualificationFixtureManifest(value: unknown): QualificationFixtureManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntheticFixtureError("manifest_invalid");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "aws-clinical-core-qualification-fixtures/2") return validateSyntheticAcceptanceManifest(value);
  if (!candidate.fixture || typeof candidate.fixture !== "object" || Array.isArray(candidate.fixture)) throw new SyntheticFixtureError("manifest_invalid");
  const { isolationConsumerPersonId, isolationConsumerSubject, ...common } = candidate.fixture as Record<string, unknown>;
  // Reuse the strict field/UUID/subject/distinctness validation only. This projection
  // is never returned or written: the fixture writer uses the explicit consumer role.
  if ("isolationWorkforcePersonId" in common || "isolationWorkforceSubject" in common) throw new SyntheticFixtureError("manifest_invalid");
  validateSyntheticAcceptanceManifest({ ...candidate, schemaVersion: "aws-clinical-core-synthetic-acceptance/1", fixture: {
    ...common, isolationWorkforcePersonId: isolationConsumerPersonId, isolationWorkforceSubject: isolationConsumerSubject,
  } });
  return value as QualificationConsumerFixtureManifest;
}

export function loadQualificationFixtureManifest(file: string): QualificationFixtureManifest {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new SyntheticFixtureError("manifest_invalid"); }
  return validateQualificationFixtureManifest(value);
}
