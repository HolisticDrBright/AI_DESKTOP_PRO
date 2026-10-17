import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSyntheticDataApiAuditReview, reviewedCandidateSha256,
  reviewedParentSha256 } from './build-aws-synthetic-data-api-audit-review.mjs';
import { account, region, stackName } from './check-aws-synthetic-data-api-audit-live-parent.mjs';
import { assessSyntheticAuditChangeSet, reviewedChangeSetArn,
  reviewedChangeSetName } from './verify-aws-synthetic-data-api-audit-review-change-set.mjs';

const liveTemplate = JSON.parse(readFileSync('infra/aws-clinical-core/template.json', 'utf8'));
const submittedTemplate = buildSyntheticDataApiAuditReview(liveTemplate);

function fixture() {
  const parameters = Array.from({ length: 7 }, (_, index) => ({ ParameterKey: `Key${index}`, ParameterValue: `Value${index}` }));
  const stack = { StackName: stackName, StackStatus: 'UPDATE_COMPLETE',
    StackId: `arn:aws:cloudformation:${region}:${account}:stack/${stackName}/fictional`, Parameters: parameters };
  return { livePreflight: { account, region, stack: stackName, parentSha256: reviewedParentSha256,
    candidateSha256: reviewedCandidateSha256, physicalSelectorsMatch: true,
    deliveryHealthy: true, reviewable: true, executionAuthorized: false },
  stack, liveTemplate: structuredClone(liveTemplate), submittedTemplate: structuredClone(submittedTemplate),
  changeSet: { ChangeSetName: reviewedChangeSetName, ChangeSetId: reviewedChangeSetArn,
    StackId: stack.StackId, Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE',
    Parameters: structuredClone(parameters), Changes: [{ ResourceChange: {
      Action: 'Modify', LogicalResourceId: 'AuditTrail', PhysicalResourceId: stackName,
      ResourceType: 'AWS::CloudTrail::Trail', Replacement: 'False', Scope: ['Properties'],
      Details: ['EventSelectors', 'AdvancedEventSelectors'].map(Name => ({
        ChangeSource: 'DirectModification', Evaluation: 'Static',
        Target: { Attribute: 'Properties', Name, RequiresRecreation: 'Never' },
      })),
    } }] } };
}

test('the exact fictional review is reviewable but never execution authority', () => {
  assert.deepEqual(assessSyntheticAuditChangeSet(fixture()),
    { reviewable: true, reasons: [], executionAuthorized: false });
});

test('wrong account, drifted parent or unavailable review refuse', () => {
  for (const mutate of [
    x => { x.livePreflight.account = '173535830222'; },
    x => { x.livePreflight.deliveryHealthy = false; },
    x => { x.stack.StackStatus = 'UPDATE_IN_PROGRESS'; },
    x => { x.liveTemplate.Description = 'drift'; },
    x => { x.changeSet.ChangeSetId = 'substituted'; },
    x => { x.changeSet.ExecutionStatus = 'OBSOLETE'; },
    x => { x.submittedTemplate.Description = 'different'; },
  ]) { const input = fixture(); mutate(input); assert.equal(assessSyntheticAuditChangeSet(input).reviewable, false); }
});

test('changed, omitted or duplicated parameters refuse', () => {
  for (const mutate of [
    x => { x.changeSet.Parameters[0].ParameterValue = 'changed'; },
    x => { x.changeSet.Parameters[0].ParameterKey = x.changeSet.Parameters[1].ParameterKey; },
    x => { x.changeSet.Parameters.pop(); },
  ]) { const input = fixture(); mutate(input); assert.ok(assessSyntheticAuditChangeSet(input).reasons.includes('parameters_changed')); }
});

test('replacement, unrelated resource and broadened trail changes refuse', () => {
  for (const mutate of [
    x => { x.changeSet.Changes[0].ResourceChange.Replacement = 'True'; },
    x => { x.changeSet.Changes[0].ResourceChange.PhysicalResourceId = 'other'; },
    x => { x.changeSet.Changes[0].ResourceChange.Details[0].Target.Name = 'S3BucketName'; },
    x => { x.changeSet.Changes[0].ResourceChange.Details[0].Target.RequiresRecreation = 'Always'; },
    x => { x.changeSet.Changes.push(structuredClone(x.changeSet.Changes[0])); },
  ]) { const input = fixture(); mutate(input); assert.ok(assessSyntheticAuditChangeSet(input).reasons.includes('resource_delta_changed')); }
});
