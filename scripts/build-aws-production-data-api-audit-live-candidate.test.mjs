import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedChanges,
  buildLiveDataApiAuditCandidate,
  digestTemplate,
  physicalAuditDeliveryHealthy,
  physicalAuditSelectorsMatch,
  reviewedLiveParentSha256,
} from "./build-aws-production-data-api-audit-live-candidate.mjs";
import { changedTemplatePaths } from "./check-aws-production-data-api-audit-live-parent.mjs";

function fictionalParent() {
  return {
    Parameters: { Example: { Type: "String" } },
    Resources: {
      AuditTrail: {
        Type: "AWS::CloudTrail::Trail",
        Properties: {
          IsLogging: true,
          EventSelectors: [{
            IncludeManagementEvents: true,
            ReadWriteType: "All",
            DataResources: [{
              Type: "AWS::S3::Object",
              Values: [{ "Fn::Sub": "${ClinicalDocumentsBucket.Arn}/" }],
            }],
          }],
        },
      },
      ClinicalDatabaseCluster: { Type: "AWS::RDS::DBCluster", Properties: {} },
      ClinicalDocumentsBucket: { Type: "AWS::S3::Bucket", Properties: {} },
      WorkforcePool: { Type: "AWS::Cognito::UserPool", Properties: { MfaConfiguration: "ON" } },
    },
  };
}

test("canonical digest is key-order independent and the live parent has a fixed pin", () => {
  const first = fictionalParent();
  assert.equal(digestTemplate(first), digestTemplate({ Resources: first.Resources, Parameters: first.Parameters }));
  assert.match(reviewedLiveParentSha256, /^[a-f0-9]{64}$/);
});

test("live candidate changes only the trail and retains all management and document object events", () => {
  const parent = fictionalParent();
  const candidate = buildLiveDataApiAuditCandidate(parent, digestTemplate(parent));
  assert.deepEqual(changedTemplatePaths(parent, candidate), allowedChanges);
  assert.deepEqual(candidate.Resources.WorkforcePool, parent.Resources.WorkforcePool);
  const trail = candidate.Resources.AuditTrail.Properties;
  assert.equal(trail.EventSelectors, undefined);
  assert.deepEqual(trail.AdvancedEventSelectors.map((item) => item.FieldSelectors[0].Equals[0]),
    ["Management", "Data", "Data"]);
  assert.equal(trail.AdvancedEventSelectors[1].FieldSelectors[1].Equals[0], "AWS::S3::Object");
  assert.equal(trail.AdvancedEventSelectors[2].FieldSelectors[1].Equals[0], "AWS::RDS::DBCluster");
  assert.deepEqual(trail.AdvancedEventSelectors[2].FieldSelectors[2].Equals[0],
    { "Fn::GetAtt": ["ClinicalDatabaseCluster", "DBClusterArn"] });
});

test("a changed parent, changed selector, or already-advanced trail is refused", () => {
  const parent = fictionalParent();
  const hash = digestTemplate(parent);
  assert.throws(() => buildLiveDataApiAuditCandidate(parent), /exact reviewed parent/);
  parent.Resources.WorkforcePool.Properties.MfaConfiguration = "OFF";
  assert.throws(() => buildLiveDataApiAuditCandidate(parent, hash), /exact reviewed parent/);
  const modified = fictionalParent();
  modified.Resources.AuditTrail.Properties.EventSelectors[0].ReadWriteType = "WriteOnly";
  assert.throws(() => buildLiveDataApiAuditCandidate(modified, digestTemplate(modified)), /management-and-documents posture/);
  modified.Resources.AuditTrail.Properties.AdvancedEventSelectors = [];
  assert.throws(() => buildLiveDataApiAuditCandidate(modified, digestTemplate(modified)), /management-and-documents posture/);
});

test("a missing cluster or document bucket is refused", () => {
  const parent = fictionalParent();
  delete parent.Resources.ClinicalDatabaseCluster;
  assert.throws(() => buildLiveDataApiAuditCandidate(parent, digestTemplate(parent)), /management-and-documents posture/);
  parent.Resources.ClinicalDatabaseCluster = { Type: "AWS::RDS::DBCluster", Properties: {} };
  delete parent.Resources.ClinicalDocumentsBucket;
  assert.throws(() => buildLiveDataApiAuditCandidate(parent, digestTemplate(parent)), /management-and-documents posture/);
});

test("physical selector drift is refused even when the original template is unchanged", () => {
  const observed = {
    EventSelectors: [{
      IncludeManagementEvents: true,
      ReadWriteType: "All",
      ExcludeManagementEventSources: [],
      DataResources: [{
        Type: "AWS::S3::Object",
        Values: ["arn:aws:s3:::fictional-documents/"],
      }],
    }],
    AdvancedEventSelectors: null,
  };
  assert.equal(physicalAuditSelectorsMatch(observed, "fictional-documents"), true);
  assert.equal(physicalAuditSelectorsMatch({ ...observed, AdvancedEventSelectors: [{}] }, "fictional-documents"), false);
  assert.equal(physicalAuditSelectorsMatch(observed, "another-bucket"), false);
  assert.equal(physicalAuditSelectorsMatch({
    ...observed,
    EventSelectors: [{ ...observed.EventSelectors[0], ExcludeManagementEventSources: ["kms.amazonaws.com"] }],
  }, "fictional-documents"), false);
});

test("a stopped trail or delivery error is refused before building a candidate", () => {
  assert.equal(physicalAuditDeliveryHealthy({ IsLogging: true }), true);
  assert.equal(physicalAuditDeliveryHealthy({ IsLogging: false }), false);
  assert.equal(physicalAuditDeliveryHealthy({ IsLogging: true, LatestDeliveryError: "denied" }), false);
  assert.equal(physicalAuditDeliveryHealthy({ IsLogging: true, LatestCloudWatchLogsDeliveryError: "denied" }), false);
});
