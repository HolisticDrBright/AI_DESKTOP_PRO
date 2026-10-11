import type { SuccessorQualificationRow } from './successor-qualification-release.mjs';
export const TELEHEALTH_REQUEST_AUTHORITY_FILE: '20261011180000_production_telehealth_request_authority.sql';
export const TELEHEALTH_REQUEST_AUTHORITY_SQL_SHA256: string;
export const TELEHEALTH_REQUEST_AUTHORITY_BODY_SHA256: string;
export function assertTelehealthRequestAuthorityRows(input: unknown): readonly SuccessorQualificationRow[];
export function telehealthRequestAuthorityCandidate(parent: unknown, source: unknown): {
  manifest: { contract_version: string; migrations: { version: string; file: string }[] };
  files: Record<string, string>; releaseHash: string;
  candidate: { contract: 'telehealth-request-authority-candidate/1'; parentMigrationCount: 117;
    parentMigrationReleaseSha256: string; parentArtifactSha256: string; migrationCount: 118;
    migrationReleaseSha256: string; extensionSha256: string; deployment: 'not_deployed'; activation: 'blocked';
    phiAllowed: false; seededApprovals: false; seededConsents: false; seededIdentities: false;
    managedRoleSemanticsVerified: false; runtimeAdmission: false };
};
