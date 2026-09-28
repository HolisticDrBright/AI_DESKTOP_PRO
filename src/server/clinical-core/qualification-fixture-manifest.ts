if (typeof window !== 'undefined') throw new Error('qualification-fixture-manifest is server-only');
import { readFileSync } from 'node:fs';
import { validateSyntheticAcceptanceManifest, type SyntheticAcceptanceManifest } from './synthetic-fixtures';

export type QualificationConsumerFixtureManifest = Omit<SyntheticAcceptanceManifest, 'schemaVersion' | 'fixture'> & {
  schemaVersion: 'aws-clinical-core-qualification-fixtures/2';
  fixture: Omit<SyntheticAcceptanceManifest['fixture'], 'isolationWorkforcePersonId' | 'isolationWorkforceSubject'> & {
    isolationConsumerPersonId: string;
    isolationConsumerSubject: string;
  };
};
export type QualificationFixtureManifest = SyntheticAcceptanceManifest | QualificationConsumerFixtureManifest;

/** v2 changes the isolation actor's role explicitly. It never silently treats a consumer as workforce. */
export function validateQualificationFixtureManifest(value: unknown): QualificationFixtureManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('qualification_manifest_invalid');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion === 'aws-clinical-core-synthetic-acceptance/1') return validateSyntheticAcceptanceManifest(value);
  if (input.schemaVersion !== 'aws-clinical-core-qualification-fixtures/2' || !input.fixture || typeof input.fixture !== 'object' || Array.isArray(input.fixture)) throw new Error('qualification_manifest_invalid');
  const fixture = input.fixture as Record<string, unknown>;
  if (Object.hasOwn(fixture, 'isolationWorkforcePersonId') || Object.hasOwn(fixture, 'isolationWorkforceSubject')) throw new Error('qualification_manifest_invalid');
  const { isolationConsumerPersonId, isolationConsumerSubject, ...common } = fixture;
  // Reuse the strict existing field/UUID/hash/label validator, solely for shape validation.
  // No normalized legacy manifest is returned or used to insert identities/memberships.
  validateSyntheticAcceptanceManifest({ ...input, schemaVersion: 'aws-clinical-core-synthetic-acceptance/1', fixture: {
    ...common, isolationWorkforcePersonId: isolationConsumerPersonId, isolationWorkforceSubject: isolationConsumerSubject,
  } });
  const artifactIds = ['consentArtifactId', 'labConsentArtifactId', 'protocolConsentArtifactId', 'nutritionConsentArtifactId', 'symptomsConsentArtifactId', 'formsConsentArtifactId'].map(key => fixture[key]);
  if (new Set(artifactIds).size !== artifactIds.length) throw new Error('qualification_manifest_invalid');
  return value as QualificationConsumerFixtureManifest;
}

export function loadQualificationFixtureManifest(file: string): QualificationFixtureManifest {
  try { return validateQualificationFixtureManifest(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
  catch { throw new Error('qualification_manifest_invalid'); }
}
