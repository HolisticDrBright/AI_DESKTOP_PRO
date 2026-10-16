import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import { buildDataApiAuditCandidate, reviewedParentSha256, sha256 } from "./build-aws-production-data-api-audit-candidate.mjs";

const source = JSON.parse(readFileSync(resolve("infra/aws-clinical-core/template.json"), "utf8"));
const parent = buildProductionFoundation(source);
assert.equal(sha256(parent), reviewedParentSha256);
const candidate = buildDataApiAuditCandidate(parent);

assert.equal(parent.Resources.AuditTrail.Properties.AdvancedEventSelectors, undefined);
assert.equal(candidate.Resources.AuditTrail.Properties.EventSelectors, undefined);
assert.equal(candidate.Resources.AuditTrail.Properties.IsLogging, true);
assert.equal(candidate.Resources.AuditTrail.Properties.IsMultiRegionTrail, true);
assert.equal(candidate.Resources.AuditTrail.Properties.EnableLogFileValidation, true);
assert.deepEqual(candidate.Resources.AuditTrail.Properties.S3BucketName, parent.Resources.AuditTrail.Properties.S3BucketName);
assert.deepEqual(candidate.Resources.AuditTrail.Properties.KMSKeyId, parent.Resources.AuditTrail.Properties.KMSKeyId);
assert.deepEqual(candidate.Resources.AuditTrail.Properties.CloudWatchLogsLogGroupArn, parent.Resources.AuditTrail.Properties.CloudWatchLogsLogGroupArn);

// Apart from the trail's selector property, this must be byte-for-byte the
// existing production foundation. In particular it cannot change PHI posture.
const restored = structuredClone(candidate);
delete restored.Resources.AuditTrail.Properties.AdvancedEventSelectors;
restored.Resources.AuditTrail.Properties.EventSelectors = structuredClone(parent.Resources.AuditTrail.Properties.EventSelectors);
assert.deepEqual(restored, parent);
assert.equal(candidate.Outputs.PhiAllowed.Value, "false");

const selectors = candidate.Resources.AuditTrail.Properties.AdvancedEventSelectors;
assert.equal(selectors.length, 3);
assert.deepEqual(selectors[0].FieldSelectors, [{ Field: "eventCategory", Equals: ["Management"] }]);
assert.deepEqual(selectors[1].FieldSelectors, [
  { Field: "eventCategory", Equals: ["Data"] },
  { Field: "resources.type", Equals: ["AWS::S3::Object"] },
  { Field: "resources.ARN", StartsWith: [{ "Fn::Sub": "${ClinicalDocumentsBucket.Arn}/" }] },
]);
assert.deepEqual(selectors[2].FieldSelectors, [
  { Field: "eventCategory", Equals: ["Data"] },
  { Field: "resources.type", Equals: ["AWS::RDS::DBCluster"] },
  { Field: "resources.ARN", Equals: [{ "Fn::GetAtt": ["ClinicalDatabaseCluster", "DBClusterArn"] }] },
]);

const drifted = structuredClone(parent);
drifted.Resources.AuditTrail.Properties.IsLogging = false;
assert.throws(() => buildDataApiAuditCandidate(drifted), /differs from the reviewed audit parent/);
assert.deepEqual(parent, buildProductionFoundation(source), "candidate build must not mutate the parent");

console.log("Production RDS Data API audit successor is narrowly scoped and parent-pinned.");
