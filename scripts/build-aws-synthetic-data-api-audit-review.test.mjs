import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSyntheticDataApiAuditReview, digestTemplate, reviewedParentSha256, reviewedCandidateSha256,
} from './build-aws-synthetic-data-api-audit-review.mjs';

const parent = JSON.parse(readFileSync('infra/aws-clinical-core/template.json', 'utf8'));

test('the checked-in foundation is the observed exact synthetic parent', () => {
  assert.equal(digestTemplate(parent), reviewedParentSha256);
});

test('review candidate preserves management and exact document-object coverage while adding only the clinical cluster', () => {
  const before = structuredClone(parent);
  const candidate = buildSyntheticDataApiAuditReview(parent);
  assert.equal(digestTemplate(candidate), reviewedCandidateSha256);
  assert.deepEqual(parent, before);
  assert.equal(candidate.Resources.AuditTrail.Properties.EventSelectors, undefined);
  const selectors = candidate.Resources.AuditTrail.Properties.AdvancedEventSelectors;
  assert.deepEqual(selectors[0].FieldSelectors, [{ Field: 'eventCategory', Equals: ['Management'] }]);
  assert.deepEqual(selectors[1].FieldSelectors, [
    { Field: 'eventCategory', Equals: ['Data'] },
    { Field: 'resources.type', Equals: ['AWS::S3::Object'] },
    { Field: 'resources.ARN', StartsWith: [{ 'Fn::Sub': '${ClinicalDocumentsBucket.Arn}/' }] },
  ]);
  assert.deepEqual(selectors[2].FieldSelectors, [
    { Field: 'eventCategory', Equals: ['Data'] },
    { Field: 'resources.type', Equals: ['AWS::RDS::DBCluster'] },
    { Field: 'resources.ARN', Equals: [{ 'Fn::GetAtt': ['ClinicalDatabaseCluster', 'DBClusterArn'] }] },
  ]);
  const withoutTrail = structuredClone(candidate);
  withoutTrail.Resources.AuditTrail = before.Resources.AuditTrail;
  assert.deepEqual(withoutTrail, before);
  const expectedProperties = structuredClone(before.Resources.AuditTrail.Properties);
  delete expectedProperties.EventSelectors;
  expectedProperties.AdvancedEventSelectors = selectors;
  assert.deepEqual(candidate.Resources.AuditTrail.Properties, {
    ...expectedProperties,
  });
});

test('changed parent, extra selector and missing resource all refuse', () => {
  const drift = structuredClone(parent);
  drift.Description = 'unexpected change';
  assert.throws(() => buildSyntheticDataApiAuditReview(drift), /exact reviewed parent/);
  const extraSelector = structuredClone(parent);
  extraSelector.Resources.AuditTrail.Properties.EventSelectors.push({ IncludeManagementEvents: false });
  assert.throws(() => buildSyntheticDataApiAuditReview(extraSelector, digestTemplate(extraSelector)),
    /reviewed management-and-documents posture/);
  const missingCluster = structuredClone(parent);
  delete missingCluster.Resources.ClinicalDatabaseCluster;
  assert.throws(() => buildSyntheticDataApiAuditReview(missingCluster, digestTemplate(missingCluster)),
    /reviewed management-and-documents posture/);
});
