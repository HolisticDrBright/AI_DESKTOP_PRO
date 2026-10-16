import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLiveDataApiAuditCandidate, digestTemplate, readExactLiveParent } from "./build-aws-production-data-api-audit-live-candidate.mjs";
import { productionAccount, productionRegion, productionStack } from "./check-aws-production-data-api-audit-live-parent.mjs";

export const reviewedChangeSetName = "review-data-api-audit-7b8cf85a-20261016";
export const reviewedChangeSetArn = "arn:aws:cloudformation:us-east-2:173535830222:changeSet/review-data-api-audit-7b8cf85a-20261016/42a2a6d7-7ece-4b7f-8580-16c08d4fb20e";
export const reviewedCandidateSha256 = "7b8cf85a807f3b6e90ba6f7e494de2132699bfc2da0f540bd163c02d28ae511e";

const expectedTargets = ["AdvancedEventSelectors", "EventSelectors"];

function unchangedParameters(current, proposed) {
  if (!Array.isArray(current) || !Array.isArray(proposed) || current.length !== 11 || proposed.length !== 11) return false;
  const values = new Map();
  for (const parameter of current) {
    if (!parameter?.ParameterKey || values.has(parameter.ParameterKey)) return false;
    values.set(parameter.ParameterKey, parameter.ParameterValue);
  }
  const seen = new Set();
  for (const parameter of proposed) {
    if (!parameter?.ParameterKey || seen.has(parameter.ParameterKey) || !values.has(parameter.ParameterKey)
      || values.get(parameter.ParameterKey) !== parameter.ParameterValue) return false;
    seen.add(parameter.ParameterKey);
  }
  return seen.size === values.size;
}

/** Read-only review, not execution authorization or delivered-event evidence. */
export function assessAuditReview({ account, stack, liveParent, changeSet, submittedTemplate },
  { expectedCandidateSha256 = reviewedCandidateSha256, buildCandidate = buildLiveDataApiAuditCandidate } = {}) {
  const reasons = [];
  if (account !== productionAccount || stack?.StackName !== productionStack
    || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack?.StackStatus)) reasons.push("target_changed");
  try {
    if (digestTemplate(buildCandidate(liveParent)) !== expectedCandidateSha256) reasons.push("candidate_changed");
  } catch { reasons.push("parent_changed"); }
  if (changeSet?.ChangeSetName !== reviewedChangeSetName || changeSet?.ChangeSetId !== reviewedChangeSetArn
    || changeSet?.StackId !== stack?.StackId || changeSet?.Status !== "CREATE_COMPLETE"
    || changeSet?.ExecutionStatus !== "AVAILABLE") reasons.push("change_set_not_available");
  if (digestTemplate(submittedTemplate) !== expectedCandidateSha256) reasons.push("submitted_template_changed");
  if (!unchangedParameters(stack?.Parameters, changeSet?.Parameters)) reasons.push("parameters_changed");

  const changes = changeSet?.Changes;
  const resource = changes?.length === 1 ? changes[0]?.ResourceChange : undefined;
  const targets = resource?.Details?.map(item => item.Target?.Name).sort();
  if (resource?.Action !== "Modify" || resource.LogicalResourceId !== "AuditTrail"
    || resource.ResourceType !== "AWS::CloudTrail::Trail" || resource.Replacement !== "False"
    || JSON.stringify(resource.Scope) !== JSON.stringify(["Properties"])
    || JSON.stringify(targets) !== JSON.stringify(expectedTargets)
    || resource.Details.some(item => item.ChangeSource !== "DirectModification"
      || item.Target?.Attribute !== "Properties" || item.Target.RequiresRecreation !== "Never")) {
    reasons.push("resource_delta_changed");
  }
  return { reviewable: reasons.length === 0, reasons, executionAuthorized: false };
}

function awsJson(profile, args) {
  return JSON.parse(execFileSync("aws", [...args, "--region", productionRegion, "--profile", profile, "--output", "json"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 12 * 1024 * 1024 }));
}

export function inspectAuditReview(profile) {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("An explicit AWS profile is required");
  const liveParent = readExactLiveParent(profile); // account, physical Trail and parent-hash checks
  const account = awsJson(profile, ["sts", "get-caller-identity"]).Account;
  const stack = awsJson(profile, ["cloudformation", "describe-stacks", "--stack-name", productionStack]).Stacks?.[0];
  const changeSet = awsJson(profile, ["cloudformation", "describe-change-set", "--change-set-name", reviewedChangeSetArn,
    "--stack-name", productionStack]);
  const response = awsJson(profile, ["cloudformation", "get-template", "--change-set-name", reviewedChangeSetArn,
    "--stack-name", productionStack, "--template-stage", "Processed"]);
  const submittedTemplate = typeof response.TemplateBody === "string" ? JSON.parse(response.TemplateBody) : response.TemplateBody;
  return assessAuditReview({ account, stack, liveParent, changeSet, submittedTemplate });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--profile") {
    console.error("Usage: node scripts/verify-aws-production-data-api-audit-review-change-set.mjs --profile <explicit-profile>");
    process.exit(2);
  }
  try {
    const result = inspectAuditReview(process.argv[3]);
    console.log(JSON.stringify(result));
    if (!result.reviewable) process.exitCode = 1;
  } catch {
    console.error("Production audit change-set review could not be verified; execution remains refused");
    process.exitCode = 2;
  }
}
