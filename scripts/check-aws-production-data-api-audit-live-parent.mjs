import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProductionFoundation } from "./build-aws-production-foundation.mjs";
import { buildDataApiAuditCandidate } from "./build-aws-production-data-api-audit-candidate.mjs";

export const productionAccount = "173535830222";
export const productionRegion = "us-east-2";
export const productionStack = "ai-longevity-production-clinical-foundation";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function changedTemplatePaths(live, parent) {
  const changed = [];
  for (const section of ["AWSTemplateFormatVersion", "Description", "Metadata", "Parameters", "Conditions", "Resources", "Outputs"]) {
    const observed = live?.[section];
    const expected = parent?.[section];
    if (JSON.stringify(canonical(observed)) === JSON.stringify(canonical(expected))) continue;
    if (!observed || !expected || typeof observed !== "object" || typeof expected !== "object" || Array.isArray(observed) || Array.isArray(expected)) {
      changed.push(section);
      continue;
    }
    for (const key of new Set([...Object.keys(observed), ...Object.keys(expected)])) {
      if (JSON.stringify(canonical(observed[key])) !== JSON.stringify(canonical(expected[key]))) {
        changed.push(`${section}.${key}`);
      }
    }
  }
  return changed.sort();
}

export function assessAuditTarget({ account, region, stackName, stackStatus, liveTemplate }, parent) {
  const reasons = [];
  if (account !== productionAccount) reasons.push("account_mismatch");
  if (region !== productionRegion) reasons.push("region_mismatch");
  if (stackName !== productionStack) reasons.push("stack_mismatch");
  if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stackStatus)) reasons.push("stack_unstable");
  const changedPaths = changedTemplatePaths(liveTemplate, parent);
  if (changedPaths.length) reasons.push("live_template_drift");
  return { ready: reasons.length === 0, reasons, changedPaths };
}

function awsJson(profile, args) {
  return JSON.parse(execFileSync("aws", [
    ...args, "--region", productionRegion, "--profile", profile, "--output", "json",
  ], { encoding: "utf8", timeout: 15000, maxBuffer: 10 * 1024 * 1024 }));
}

export function inspectLiveTarget(profile, parent) {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("An explicit AWS profile is required");
  const account = awsJson(profile, ["sts", "get-caller-identity"]).Account;
  if (account !== productionAccount) return { ready: false, reasons: ["account_mismatch"], changedPaths: [] };
  const stack = awsJson(profile, ["cloudformation", "describe-stacks", "--stack-name", productionStack]).Stacks?.[0];
  if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    return { ready: false, reasons: ["stack_unstable"], changedPaths: [] };
  }
  const response = awsJson(profile, [
    "cloudformation", "get-template", "--stack-name", productionStack, "--template-stage", "Original",
  ]);
  const liveTemplate = typeof response.TemplateBody === "string"
    ? JSON.parse(response.TemplateBody) : response.TemplateBody;
  return assessAuditTarget({
    account, region: productionRegion, stackName: stack.StackName,
    stackStatus: stack.StackStatus, liveTemplate,
  }, parent);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--profile") {
    console.error("Usage: node scripts/check-aws-production-data-api-audit-live-parent.mjs --profile <explicit-profile>");
    process.exit(2);
  }
  try {
    const source = JSON.parse(readFileSync(resolve("infra/aws-clinical-core/template.json"), "utf8"));
    const parent = buildProductionFoundation(source);
    buildDataApiAuditCandidate(parent);
    const result = inspectLiveTarget(process.argv[3], parent);
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } catch {
    console.error("Live audit parent could not be verified; deployment is refused");
    process.exitCode = 2;
  }
}
