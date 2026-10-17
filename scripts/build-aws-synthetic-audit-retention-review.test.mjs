import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSyntheticDataApiAuditReview, digestTemplate,
} from './build-aws-synthetic-data-api-audit-review.mjs';
import {
  buildSyntheticAuditRetentionReview, reviewedRetentionParentSha256,
  reviewedRetentionCandidateSha256, syntheticCloudTrailPrefix,
} from './build-aws-synthetic-audit-retention-review.mjs';

const source = JSON.parse(readFileSync('infra/aws-clinical-core/template.json', 'utf8'));
const parent = buildSyntheticDataApiAuditReview(source);

test('retention proposal pins the audit successor and changes only the audit bucket', () => {
  assert.equal(digestTemplate(parent), reviewedRetentionParentSha256);
  const candidate = buildSyntheticAuditRetentionReview(parent);
  assert.equal(digestTemplate(candidate), reviewedRetentionCandidateSha256);
  const originalBucket = parent.Resources.AuditBucket;
  assert.deepEqual({ ...candidate.Resources, AuditBucket: originalBucket }, parent.Resources);
  const rules = candidate.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules;
  assert.deepEqual(rules[0], parent.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules[0]);
  assert.deepEqual(rules[1], {
    Id: 'ExpireSyntheticCloudTrailVersions', Status: 'Enabled',
    Prefix: syntheticCloudTrailPrefix, ExpirationInDays: 364,
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
  });
  assert.deepEqual(rules[2], { Id: 'RemoveExpiredAuditDeleteMarkers', Status: 'Enabled',
    Prefix: syntheticCloudTrailPrefix,
    ExpiredObjectDeleteMarker: true });
  assert.equal(source.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 365);
  const changedFromLive = Object.keys(candidate.Resources).filter(name =>
    JSON.stringify(candidate.Resources[name]) !== JSON.stringify(source.Resources[name]));
  assert.deepEqual(changedFromLive, ['AuditBucket', 'AuditTrail']);
  assert.deepEqual(Object.keys(candidate.Resources), Object.keys(source.Resources));
});

test('unreviewed parent, versioning and lifecycle changes refuse', () => {
  assert.throws(() => buildSyntheticAuditRetentionReview(source), /exact reviewed audit candidate/);
  for (const change of [
    x => { x.Resources.AuditBucket.Properties.VersioningConfiguration.Status = 'Suspended'; },
    x => { x.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays = 730; },
    x => { x.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules.push({ Id: 'other' }); },
    x => { x.Resources.AuditTrail.Properties.IsLogging = false; },
  ]) {
    const changed = structuredClone(parent);
    change(changed);
    assert.throws(() => buildSyntheticAuditRetentionReview(changed), /exact reviewed audit candidate/);
  }
});

test('a caller cannot replace the pinned candidate hash', () => {
  const candidate = buildSyntheticAuditRetentionReview(parent);
  candidate.Resources.AuditBucket.Properties.LifecycleConfiguration.Rules[1].ExpirationInDays = 365;
  assert.notEqual(digestTemplate(candidate), reviewedRetentionCandidateSha256);
});
