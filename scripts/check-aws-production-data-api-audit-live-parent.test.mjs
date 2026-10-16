import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import {
  assessAuditTarget, changedTemplatePaths,
  productionAccount, productionRegion, productionStack,
} from "./check-aws-production-data-api-audit-live-parent.mjs";

const parent = buildProductionFoundation(JSON.parse(readFileSync("infra/aws-clinical-core/template.json", "utf8")));
const observation = (liveTemplate = structuredClone(parent)) => ({
  account: productionAccount, region: productionRegion, stackName: productionStack,
  stackStatus: "UPDATE_COMPLETE", liveTemplate,
});

assert.deepEqual(assessAuditTarget(observation(), parent), { ready: true, reasons: [], changedPaths: [] });
for (const [key, value, reason] of [
  ["account", "588966314750", "account_mismatch"],
  ["region", "us-east-1", "region_mismatch"],
  ["stackName", "another-stack", "stack_mismatch"],
  ["stackStatus", "UPDATE_IN_PROGRESS", "stack_unstable"],
]) {
  const result = assessAuditTarget({ ...observation(), [key]: value }, parent);
  assert.equal(result.ready, false);
  assert(result.reasons.includes(reason));
}

const live = structuredClone(parent);
delete live.Resources.WorkforceUserPool.Properties.EmailConfiguration;
live.Resources.ConsumerUserPoolClient.Properties.ReadAttributes = ["email"];
const result = assessAuditTarget(observation(live), parent);
assert.equal(result.ready, false);
assert.deepEqual(result.reasons, ["live_template_drift"]);
assert(result.changedPaths.includes("Resources.WorkforceUserPool"));
assert(result.changedPaths.includes("Resources.ConsumerUserPoolClient"));
assert(!JSON.stringify(result).includes("Your AI Longevity Pro code"));

const reordered = Object.fromEntries(Object.entries(parent).reverse());
assert.deepEqual(changedTemplatePaths(reordered, parent), []);
const otherTrail = structuredClone(parent);
otherTrail.Resources.AuditTrail.Properties.IsLogging = false;
assert.deepEqual(changedTemplatePaths(otherTrail, parent), ["Resources.AuditTrail"]);

console.log("Production Data API audit live-parent preflight rejects account and template drift.");
