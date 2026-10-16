import assert from "node:assert/strict";
import test from "node:test";
import { assessAuditReview, reviewedChangeSetArn, reviewedChangeSetName } from "./verify-aws-production-data-api-audit-review-change-set.mjs";
import { digestTemplate } from "./build-aws-production-data-api-audit-live-candidate.mjs";
import { productionAccount, productionStack } from "./check-aws-production-data-api-audit-live-parent.mjs";

function fixture() {
  const candidate = { Resources: { AuditTrail: { Type: "AWS::CloudTrail::Trail", Properties: { AdvancedEventSelectors: [] } } } };
  const parameters = Array.from({ length: 11 }, (_, index) => ({ ParameterKey: `Key${index}`, ParameterValue: `Value${index}` }));
  const stack = { StackName: productionStack, StackStatus: "UPDATE_COMPLETE", StackId: `arn:aws:cloudformation:us-east-2:${productionAccount}:stack/${productionStack}/fixture`, Parameters: parameters };
  const resource = { Action: "Modify", LogicalResourceId: "AuditTrail", ResourceType: "AWS::CloudTrail::Trail", Replacement: "False", Scope: ["Properties"], Details: [
    { ChangeSource: "DirectModification", Target: { Attribute: "Properties", Name: "EventSelectors", RequiresRecreation: "Never" } },
    { ChangeSource: "DirectModification", Target: { Attribute: "Properties", Name: "AdvancedEventSelectors", RequiresRecreation: "Never" } },
  ] };
  const changeSet = { ChangeSetName: reviewedChangeSetName, ChangeSetId: reviewedChangeSetArn, StackId: stack.StackId,
    Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE", Parameters: structuredClone(parameters), Changes: [{ ResourceChange: resource }] };
  const input = { account: productionAccount, stack, liveParent: { fixture: true }, changeSet, submittedTemplate: structuredClone(candidate) };
  const options = { expectedCandidateSha256: digestTemplate(candidate), buildCandidate: () => candidate };
  return { input, options };
}

test("an exact available, in-place review remains non-executable evidence", () => {
  const { input, options } = fixture();
  assert.deepEqual(assessAuditReview(input, options), { reviewable: true, reasons: [], executionAuthorized: false });
});

test("wrong target, expired change set, edited template and changed parameter refuse", () => {
  for (const mutate of [
    input => { input.account = "588966314750"; },
    input => { input.stack.StackStatus = "UPDATE_IN_PROGRESS"; },
    input => { input.changeSet.ExecutionStatus = "OBSOLETE"; },
    input => { input.changeSet.ChangeSetId = "substituted"; },
    input => { input.submittedTemplate.Resources.Extra = {}; },
    input => { input.changeSet.Parameters[0].ParameterValue = "changed"; },
    input => { input.changeSet.Parameters[0].ParameterKey = input.changeSet.Parameters[1].ParameterKey; },
  ]) {
    const { input, options } = fixture();
    mutate(input);
    assert.equal(assessAuditReview(input, options).reviewable, false);
  }
});

test("addition, replacement, broadening and extra resource all refuse", () => {
  for (const mutate of [
    input => { input.changeSet.Changes[0].ResourceChange.Action = "Add"; },
    input => { input.changeSet.Changes[0].ResourceChange.Replacement = "True"; },
    input => { input.changeSet.Changes[0].ResourceChange.LogicalResourceId = "WorkforcePool"; },
    input => { input.changeSet.Changes[0].ResourceChange.Details[0].Target.Name = "S3BucketName"; },
    input => { input.changeSet.Changes.push(structuredClone(input.changeSet.Changes[0])); },
  ]) {
    const { input, options } = fixture();
    mutate(input);
    assert.ok(assessAuditReview(input, options).reasons.includes("resource_delta_changed"));
  }
});

test("changed generated candidate refuses even if the submitted template matches", () => {
  const { input, options } = fixture();
  options.buildCandidate = () => ({ different: true });
  assert.ok(assessAuditReview(input, options).reasons.includes("candidate_changed"));
});
