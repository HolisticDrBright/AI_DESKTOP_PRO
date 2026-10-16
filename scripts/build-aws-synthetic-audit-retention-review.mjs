import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSyntheticDataApiAuditReview, digestTemplate, reviewedCandidateSha256,
} from './build-aws-synthetic-data-api-audit-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'infra/aws-clinical-core/template.json');
const outputPath = resolve(root, 'dist/aws-clinical-core/synthetic-audit-retention-review.json');

// This is a proposal layered on the exact, unexecuted Data API audit candidate.
// It is not a replacement for retention/security approval or a deletion receipt.
export const reviewedRetentionParentSha256 = reviewedCandidateSha256;
export const reviewedRetentionCandidateSha256 = 'f91a8b3ea4b0c81fb7b4ff39483e18e7e8c76c87b0ca2b6e7fddabbe29126ef0';
export const syntheticCloudTrailPrefix = 'AWSLogs/588966314750/';

export function buildSyntheticAuditRetentionReview(parent,
  expectedSha256 = reviewedRetentionParentSha256) {
  if (digestTemplate(parent) !== expectedSha256) {
    throw new Error('Synthetic audit retention is not based on the exact reviewed audit candidate');
  }
  const bucket = parent?.Resources?.AuditBucket;
  const rules = bucket?.Properties?.LifecycleConfiguration?.Rules;
  if (bucket?.Type !== 'AWS::S3::Bucket' ||
      bucket?.Properties?.VersioningConfiguration?.Status !== 'Enabled' ||
      !Array.isArray(rules) || rules.length !== 1 ||
      rules[0]?.Id !== 'ArchiveAuditLogs' || rules[0]?.Status !== 'Enabled' ||
      rules[0]?.ExpirationInDays !== 365 ||
      JSON.stringify(rules[0]?.Transitions) !==
        JSON.stringify([{ StorageClass: 'STANDARD_IA', TransitionInDays: 30 }]) ||
      rules[0]?.NoncurrentVersionExpiration !== undefined) {
    throw new Error('Synthetic audit bucket retention differs from the reviewed parent');
  }
  const candidate = structuredClone(parent);
  const nextRules = candidate.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules;
  // Preserve the bucket-wide 365-day rule. The additional, overlapping rule
  // changes retention only for this synthetic account's CloudTrail log path.
  // For an unreplaced log, day-364 expiration makes it noncurrent; one more
  // noncurrent day makes permanent deletion eligible near day 365.
  nextRules.push({
    Id: 'ExpireSyntheticCloudTrailVersions', Status: 'Enabled',
    Prefix: syntheticCloudTrailPrefix,
    ExpirationInDays: 364,
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
  });
  nextRules.push({
    Id: 'RemoveExpiredAuditDeleteMarkers', Status: 'Enabled',
    Prefix: syntheticCloudTrailPrefix,
    ExpiredObjectDeleteMarker: true,
  });
  if (expectedSha256 === reviewedRetentionParentSha256 &&
      digestTemplate(candidate) !== reviewedRetentionCandidateSha256) {
    throw new Error('Synthetic audit retention proposal differs from the pinned result');
  }
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--build-review-only') {
    console.error('Usage: node scripts/build-aws-synthetic-audit-retention-review.mjs --build-review-only');
    process.exitCode = 2;
  } else {
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const parent = buildSyntheticDataApiAuditReview(source);
    const candidate = buildSyntheticAuditRetentionReview(parent);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
    console.log(JSON.stringify({ outputPath, parentSha256: digestTemplate(parent),
      candidateSha256: digestTemplate(candidate), awsWrites: false,
      retentionApproved: false, executionAuthorized: false }));
  }
}
