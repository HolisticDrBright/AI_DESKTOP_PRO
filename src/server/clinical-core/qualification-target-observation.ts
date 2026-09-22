if (typeof window !== "undefined") throw new Error("clinical-core/qualification-target-observation is server-only.");
import { execFileSync } from "node:child_process";
import { assertQualificationStackOutputs, designatedSubjects, QualificationTargetManifestError, type QualificationStackPosture, type QualificationTargetManifest } from "./qualification-target-manifest";

/**
 * What a hosted run observed for itself. The acceptance CLIs used to take the account from
 * `OBSERVED_AWS_ACCOUNT_ID` and prefer `SOURCE_COMMIT` over the checkout's real head, and they repeated none of the
 * wrapper's live stack checks: an environment variable is an assertion by whoever set it, not an observation, so a direct
 * CLI run could claim a target it had never looked at. This module makes the CLI do the looking: it runs `git rev-parse
 * HEAD`, `aws sts get-caller-identity` and `aws cloudformation describe-stacks` itself, checks every result against the
 * reviewed manifest, and refuses before the first request or fixture write. An acceptance verdict is only issued from an
 * observation obtained here; `ACCEPTANCE_MODE=exploratory` may run on asserted values and says so in its report line.
 */
export type QualificationObservation = {
  source: "observed";
  awsAccountId: string;
  sourceCommit: string;
  /** Each candidate stack this run depends on, with the status and the resource parameters that were compared. */
  stacks: Array<{ candidate: string; stackName: string; stackStatus: string }>;
};

type Runner = (file: string, args: string[]) => string;
const defaultRunner: Runner = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

function run(runner: Runner, file: string, args: string[], category: QualificationTargetManifestError["category"], field: string): string {
  let out: string;
  try { out = runner(file, args); } catch { throw new QualificationTargetManifestError(category, field); }
  const value = out.trim();
  if (!value) throw new QualificationTargetManifestError(category, field);
  return value;
}

/** Observes the live target for the candidates this run needs. Nothing is written and nothing but read-only calls are made. */
export function observeQualificationTarget(manifest: QualificationTargetManifest, candidates: readonly string[], options: { runner?: Runner; posture?: QualificationStackPosture } = {}): QualificationObservation {
  const runner = options.runner ?? defaultRunner;
  const sourceCommit = run(runner, "git", ["rev-parse", "HEAD"], "target_source_mismatch", "git");
  if (sourceCommit !== manifest.sourceCommit) throw new QualificationTargetManifestError("target_source_mismatch", "checkout");
  const awsAccountId = run(runner, "aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], "target_account_refused", "sts");
  if (!/^\d{12}$/.test(awsAccountId) || awsAccountId !== manifest.awsAccountId) throw new QualificationTargetManifestError("target_account_refused", "sts");
  const foundation = describe(runner, manifest.foundationStackName, manifest.awsRegion, "foundation");
  if (foundation.outputs.PhiAllowed !== "false") throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  for (const [key, expected] of [["ApiId", manifest.apiId], ["ApiOrigin", manifest.apiOrigin], ["DatabaseName", manifest.databaseName], ["ExportBucketName", manifest.exportBucket]] as const) {
    if (foundation.outputs[key] !== undefined && foundation.outputs[key] !== expected) throw new QualificationTargetManifestError("target_stack_refused", "foundation");
  }
  const stacks: QualificationObservation["stacks"] = [];
  for (const candidate of candidates) {
    const stackName = manifest.stacks[candidate];
    if (!stackName || stackName === manifest.refused.stagingFoundationStackName || stackName === manifest.foundationStackName) throw new QualificationTargetManifestError("target_stack_refused", candidate);
    const stack = describe(runner, stackName, manifest.awsRegion, candidate);
    assertQualificationStackOutputs(candidate, stack.outputs, manifest, stack.parameters, stack.status, options.posture ?? "qualification");
    stacks.push({ candidate, stackName, stackStatus: stack.status });
  }
  return { source: "observed", awsAccountId, sourceCommit, stacks };
}

function describe(runner: Runner, stackName: string, region: string, field: string): { outputs: Record<string, string | undefined>; parameters: Record<string, string | undefined>; status: string } {
  const raw = run(runner, "aws", ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0]", "--output", "json"], "target_stack_refused", field);
  let parsed: { Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>; Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>; StackStatus?: string } | null;
  try { parsed = JSON.parse(raw); } catch { throw new QualificationTargetManifestError("target_stack_refused", field); }
  if (!parsed || typeof parsed !== "object" || typeof parsed.StackStatus !== "string") throw new QualificationTargetManifestError("target_stack_refused", field);
  const outputs: Record<string, string | undefined> = {}, parameters: Record<string, string | undefined> = {};
  for (const entry of parsed.Outputs ?? []) if (entry?.OutputKey) outputs[entry.OutputKey] = entry.OutputValue;
  for (const entry of parsed.Parameters ?? []) if (entry?.ParameterKey) parameters[entry.ParameterKey] = entry.ParameterValue;
  return { outputs, parameters, status: parsed.StackStatus };
}

/** The candidate stacks each harness depends on. */
export const EXPORT_ACCEPTANCE_CANDIDATES = ["personal-storage", "privacy-operations"] as const;
export const RECORDING_ACCEPTANCE_CANDIDATES = ["recording-authority", "recording-capture", "recording-transcription", "recording-drafting", "recording-cleanup-review"] as const;

/** The designated subjects a run's tokens must belong to, for the record the CLI prints. */
export function observedSubjects(manifest: QualificationTargetManifest): number { return designatedSubjects(manifest.identitySubjects).length; }
