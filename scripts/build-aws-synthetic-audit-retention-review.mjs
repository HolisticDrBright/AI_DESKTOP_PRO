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
export const reviewedRetentionCandidateSha256 = '0a2a460280c5324226660250ccd9ff4cb951e8c3b18558c7e5e6dd6c16b2d124';

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
  // For an unreplaced CloudTrail file, current expiration at day 364 makes the
  // version noncurrent; one more day makes permanent deletion eligible near day 365.
  nextRules[0].ExpirationInDays = 364;
  nextRules[0].NoncurrentVersionExpiration = { NoncurrentDays: 1 };
  nextRules.push({
    Id: 'RemoveExpiredAuditDeleteMarkers', Status: 'Enabled',
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
