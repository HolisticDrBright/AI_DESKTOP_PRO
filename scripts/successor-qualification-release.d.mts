export type SuccessorQualificationRow = Readonly<{ version: string; name: string; sha256: string }>;
export const SUCCESSOR_QUALIFICATION_RELEASE: Readonly<{
  qualificationProfile: 'clinical-successor-qualification/1'; migrationCount: 117;
  migrationReleaseSha256: string; migrationAssemblySha256: string;
}>;
export function assertSuccessorQualificationRows(input: unknown): readonly SuccessorQualificationRow[];
export function successorQualificationReleaseArtifact(input: unknown): Readonly<{
  contract: 'successor-qualification-release-artifact/1';
  qualificationProfile: 'clinical-successor-qualification/1'; migrationCount: 117;
  migrationReleaseSha256: string; migrationAssemblySha256: string; rows: readonly SuccessorQualificationRow[];
  executionAllowed: false; managedQualified: false; deploymentPerformed: false; phiAllowed: false;
}>;
