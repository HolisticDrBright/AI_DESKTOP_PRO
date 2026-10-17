import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessAuditLiveParent, account, stackName } from './check-aws-synthetic-data-api-audit-live-parent.mjs';

const template = JSON.parse(readFileSync('infra/aws-clinical-core/template.json', 'utf8'));
const bucket = 'ai-clinical-core-synthetic-clinicaldocumentsbucket-1wv5abdrcnn7';
const fixture = () => ({
  caller: { Account: account,
    Arn: `arn:aws:sts::${account}:assumed-role/OrganizationAccountAccessRole/fictional-review` },
  stack: { StackName: stackName, StackStatus: 'UPDATE_COMPLETE', Parameters: [
    { ParameterKey: 'ProjectName', ParameterValue: 'ai-clinical-core' },
    { ParameterKey: 'EnvironmentName', ParameterValue: 'synthetic-staging' },
    { ParameterKey: 'DataClassification', ParameterValue: 'synthetic_only' },
    { ParameterKey: 'DatabaseName', ParameterValue: 'clinical_core' },
  ] },
  template,
  trailResource: { LogicalResourceId: 'AuditTrail', PhysicalResourceId: stackName },
  bucketResource: { LogicalResourceId: 'ClinicalDocumentsBucket', PhysicalResourceId: bucket },
  clusterResource: { LogicalResourceId: 'ClinicalDatabaseCluster',
    PhysicalResourceId: 'ai-clinical-core-synthetic-clinicaldatabasecluster-lftvrccuflxa' },
  selectors: { AdvancedEventSelectors: [], EventSelectors: [{ IncludeManagementEvents: true,
    ReadWriteType: 'All', ExcludeManagementEventSources: [], DataResources: [{ Type: 'AWS::S3::Object',
      Values: [`arn:aws:s3:::${bucket}/`] }] }] },
  trailStatus: { IsLogging: true, LatestDeliveryError: null, LatestCloudWatchLogsDeliveryError: null },
});

test('exact fictional live posture permits review but never execution', () => {
  assert.deepEqual(assessAuditLiveParent(fixture()), {
    account, region: 'us-east-2', stack: stackName,
    parentSha256: 'caef0835807f66820b2814aa9314660ba3b9a562591cd6989335118698b1522f',
    candidateSha256: '371d8136e8e3215707338e3721cefb732d953dac32d05afc36dd90e330ac4152',
    physicalSelectorsMatch: true, deliveryHealthy: true, reviewable: true, executionAuthorized: false,
  });
});

test('wrong account, production classification and incomplete stacks refuse', () => {
  for (const change of [
    x => { x.caller.Account = '173535830222'; },
    x => { x.caller.Arn = `arn:aws:iam::${account}:root`; },
    x => { x.stack.Parameters[2].ParameterValue = 'phi'; },
    x => { x.stack.StackStatus = 'UPDATE_IN_PROGRESS'; },
  ]) { const x = fixture(); change(x); assert.throws(() => assessAuditLiveParent(x), /not reviewable/); }
});

test('template and physical resource drift refuse', () => {
  for (const change of [
    x => { x.template = structuredClone(template); x.template.Description = 'drift'; },
    x => { x.bucketResource.PhysicalResourceId = 'other'; },
    x => { x.clusterResource.PhysicalResourceId = 'other'; },
    x => { x.trailResource.PhysicalResourceId = 'other'; },
  ]) { const x = fixture(); change(x); assert.throws(() => assessAuditLiveParent(x), /not reviewable/); }
});

test('broadened, missing or replaced selectors refuse', () => {
  for (const change of [
    x => { x.selectors.AdvancedEventSelectors = [{ Name: 'already changed' }]; },
    x => { x.selectors.EventSelectors[0].IncludeManagementEvents = false; },
    x => { x.selectors.EventSelectors[0].DataResources[0].Values[0] = 'arn:aws:s3:::other/'; },
    x => { x.selectors.EventSelectors.push({ IncludeManagementEvents: true }); },
    x => { x.selectors.EventSelectors[0].ExcludeManagementEventSources = ['rdsdata.amazonaws.com']; },
  ]) { const x = fixture(); change(x); assert.throws(() => assessAuditLiveParent(x), /not reviewable/); }
});

test('stopped or failing delivery refuses', () => {
  for (const change of [
    x => { x.trailStatus.IsLogging = false; },
    x => { x.trailStatus.LatestDeliveryError = 'AccessDenied'; },
    x => { x.trailStatus.LatestCloudWatchLogsDeliveryError = 'AccessDenied'; },
  ]) { const x = fixture(); change(x); assert.throws(() => assessAuditLiveParent(x), /not reviewable/); }
});
