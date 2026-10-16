import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataApiAdvancedSelectors } from "./build-aws-production-data-api-audit-candidate.mjs";
import {
  changedTemplatePaths,
  productionAccount,
  productionRegion,
  productionStack,
} from "./check-aws-production-data-api-audit-live-parent.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(root, "dist/aws-clinical-core/production-data-api-audit-live-candidate.json");

// GetTemplate(Original) for the stable live foundation, not the checked-in
// source parent. Re-observe and review before changing this pin.
export const reviewedLiveParentSha256 = "940aa70ca239a0d1403d0adabfbdd8f87bbebf3aab975607d1cde70c491f290d";
export const allowedChanges = ["Resources.AuditTrail"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function digestTemplate(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function expectedBasicSelectors() {
  return [{
    IncludeManagementEvents: true,
    ReadWriteType: "All",
    DataResources: [{
      Type: "AWS::S3::Object",
      Values: [{ "Fn::Sub": "${ClinicalDocumentsBucket.Arn}/" }],
    }],
  }];
}

export function buildLiveDataApiAuditCandidate(live, expectedParentSha256 = reviewedLiveParentSha256) {
  if (digestTemplate(live) !== expectedParentSha256) {
    throw new Error("Live clinical foundation is not the exact reviewed parent");
  }
  const trail = live?.Resources?.AuditTrail;
  if (trail?.Type !== "AWS::CloudTrail::Trail" ||
      live?.Resources?.ClinicalDatabaseCluster?.Type !== "AWS::RDS::DBCluster" ||
      live?.Resources?.ClinicalDocumentsBucket?.Type !== "AWS::S3::Bucket" ||
      trail.Properties?.AdvancedEventSelectors ||
      JSON.stringify(canonical(trail.Properties?.EventSelectors)) !== JSON.stringify(canonical(expectedBasicSelectors()))) {
    throw new Error("Live audit trail is not in the reviewed management-and-documents posture");
  }
  const candidate = structuredClone(live);
  delete candidate.Resources.AuditTrail.Properties.EventSelectors;
  candidate.Resources.AuditTrail.Properties.AdvancedEventSelectors = dataApiAdvancedSelectors();
  const changes = changedTemplatePaths(live, candidate);
  if (JSON.stringify(changes) !== JSON.stringify(allowedChanges)) {
    throw new Error("Data API audit candidate changes an unreviewed template path");
  }
  return candidate;
}

function awsJson(profile, args) {
  return JSON.parse(execFileSync("aws", [
    ...args, "--region", productionRegion, "--profile", profile, "--output", "json",
  ], { encoding: "utf8", timeout: 15000, maxBuffer: 10 * 1024 * 1024 }));
}

export function readExactLiveParent(profile) {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("An explicit AWS profile is required");
  const account = awsJson(profile, ["sts", "get-caller-identity"]).Account;
  if (account !== productionAccount) throw new Error("Wrong AWS account");
  const stack = awsJson(profile, ["cloudformation", "describe-stacks", "--stack-name", productionStack]).Stacks?.[0];
  if (stack?.StackName !== productionStack ||
      !["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(stack.StackStatus)) {
    throw new Error("Production clinical foundation is not stable");
  }
  const response = awsJson(profile, [
    "cloudformation", "get-template", "--stack-name", productionStack, "--template-stage", "Original",
  ]);
  if (typeof response.TemplateBody === "string") return JSON.parse(response.TemplateBody);
  if (!response.TemplateBody || typeof response.TemplateBody !== "object") {
    throw new Error("Production clinical foundation template was unavailable");
  }
  return response.TemplateBody;
}

export function buildFromLive(profile, outputPath = defaultOutput) {
  const parent = readExactLiveParent(profile);
  const candidate = buildLiveDataApiAuditCandidate(parent);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(candidate)}\n`);
  return {
    outputPath,
    parentSha256: digestTemplate(parent),
    candidateSha256: digestTemplate(candidate),
    changedPaths: allowedChanges,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, flag, profile] = process.argv.slice(2);
  if (!["--inspect", "--build"].includes(mode) || flag !== "--profile" || !profile || process.argv.length !== 5) {
    console.error("Usage: node scripts/build-aws-production-data-api-audit-live-candidate.mjs --inspect|--build --profile <explicit-profile>");
    process.exit(2);
  }
  try {
    if (mode === "--inspect") {
      const parent = readExactLiveParent(profile);
      console.log(JSON.stringify({ parentSha256: digestTemplate(parent), reviewed: digestTemplate(parent) === reviewedLiveParentSha256 }));
    } else {
      console.log(JSON.stringify(buildFromLive(profile)));
    }
  } catch {
    console.error("Exact-live Data API audit candidate refused");
    process.exitCode = 1;
  }
}
