if (typeof window !== "undefined") throw new Error("clinical-core/qualification-target-observation is server-only.");
import { execFileSync } from "node:child_process";
import { assertQualificationStackOutputs, designatedSubjects, QualificationTargetManifestError, type QualificationStackPosture, type QualificationTargetManifest } from "./qualification-target-manifest";
import { boundaryDigest, fingerprintStack, type AcceptanceBoundarySnapshot, type ObservedQualificationTarget } from "./qualification-target-boundary";

/**
 * What a hosted run observed for itself. The acceptance CLIs used to take the account from
 * `OBSERVED_AWS_ACCOUNT_ID` and prefer `SOURCE_COMMIT` over the checkout's real head, and they repeated none of the
 * wrapper's live stack checks: an environment variable is an assertion by whoever set it, not an observation, so a direct
 * CLI run could claim a target it had never looked at. This module makes the CLI do the looking: it runs `git rev-parse
 * HEAD`, `aws sts get-caller-identity` and `aws cloudformation describe-stacks` itself, checks every result against the
 * reviewed manifest, and refuses before the first request or fixture write. An acceptance verdict is only issued from an
 * observation obtained here; `ACCEPTANCE_MODE=exploratory` may run on asserted values and says so in its report line.
 * Each stack read is fingerprinted (qualification-target-boundary.ts), so an acceptance run can observe the same
 * target again after its last request and refuse a deployment that changed while it ran.
 */
export type QualificationObservation = ObservedQualificationTarget;

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
  const identityText = run(runner, "aws", ["sts", "get-caller-identity", "--output", "json"], "target_account_refused", "sts");
  let identity: { Account?: unknown; Arn?: unknown };
  try { identity = JSON.parse(identityText) as { Account?: unknown; Arn?: unknown }; }
  catch { throw new QualificationTargetManifestError("target_account_refused", "sts"); }
  const awsAccountId = identity?.Account;
  if (typeof awsAccountId !== "string" || !/^\d{12}$/.test(awsAccountId) || awsAccountId !== manifest.awsAccountId) {
    throw new QualificationTargetManifestError("target_account_refused", "sts");
  }
  if (typeof identity.Arn !== "string" || !new RegExp(`^arn:aws:sts::${awsAccountId}:assumed-role/[A-Za-z0-9_+=,.@/-]+$`).test(identity.Arn)) {
    throw new QualificationTargetManifestError("target_account_refused", "principal");
  }
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
    stacks.push(fingerprintStack(candidate, stackName, stack));
  }
  return { source: "observed", awsAccountId, sourceCommit, foundation: fingerprintStack("foundation", manifest.foundationStackName, foundation), stacks };
}

type DescribedStack = { outputs: Record<string, string | undefined>; parameters: Record<string, string | undefined>; status: string; stackId?: unknown; creationTime?: unknown; lastUpdatedTime?: unknown };
function describe(runner: Runner, stackName: string, region: string, field: string): DescribedStack {
  const raw = run(runner, "aws", ["cloudformation", "describe-stacks", "--stack-name", stackName, "--region", region, "--query", "Stacks[0]", "--output", "json"], "target_stack_refused", field);
  let parsed: { Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>; Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>; StackStatus?: string;
    StackId?: unknown; CreationTime?: unknown; LastUpdatedTime?: unknown } | null;
  try { parsed = JSON.parse(raw); } catch { throw new QualificationTargetManifestError("target_stack_refused", field); }
  if (!parsed || typeof parsed !== "object" || typeof parsed.StackStatus !== "string") throw new QualificationTargetManifestError("target_stack_refused", field);
  const outputs: Record<string, string | undefined> = {}, parameters: Record<string, string | undefined> = {};
  for (const entry of parsed.Outputs ?? []) if (entry?.OutputKey) outputs[entry.OutputKey] = entry.OutputValue;
  for (const entry of parsed.Parameters ?? []) if (entry?.ParameterKey) parameters[entry.ParameterKey] = entry.ParameterValue;
  return { outputs, parameters, status: parsed.StackStatus, stackId: parsed.StackId, creationTime: parsed.CreationTime, lastUpdatedTime: parsed.LastUpdatedTime };
}

/** The candidate stacks each harness depends on. */
export const EXPORT_ACCEPTANCE_CANDIDATES = ["personal-storage", "privacy-operations"] as const;
export const RECORDING_ACCEPTANCE_CANDIDATES = ["recording-authority", "recording-capture", "recording-transcription", "recording-drafting", "recording-cleanup-review"] as const;

/** The designated subjects a run's tokens must belong to, for the record the CLI prints. */
export function observedSubjects(manifest: QualificationTargetManifest): number { return designatedSubjects(manifest.identitySubjects).length; }

/**
 * One observation at a safe boundary of an acceptance run: before its first request or fixture write, or after its
 * last request. The checkout must be clean (`git status --porcelain --untracked-files=all` prints nothing): HEAD alone
 * does not say what the working tree runs, so an edited or untracked file refuses the run before any AWS call, as the
 * load runner and the care inspector already do. Then the target is observed as above. `asserted` carries what a
 * wrapper observed and passed on (`SOURCE_COMMIT`, `OBSERVED_AWS_ACCOUNT_ID`): it can never stand in for this
 * observation, and a value that disagrees with it is refused, because it means the checkout or the signed-in account
 * changed between the wrapper's check and this one.
 */
export function observeAcceptanceBoundary(manifest: QualificationTargetManifest, candidates: readonly string[],
  options: { runner?: Runner; posture?: QualificationStackPosture; asserted?: { readonly [name: string]: string | undefined } } = {}): AcceptanceBoundarySnapshot {
  const runner = options.runner ?? defaultRunner;
  let status: string;
  try { status = runner("git", ["status", "--porcelain", "--untracked-files=all"]); } catch { throw new QualificationTargetManifestError("target_source_dirty", "git"); }
  if (typeof status !== "string" || status.trim()) throw new QualificationTargetManifestError("target_source_dirty", "checkout");
  const observation = observeQualificationTarget(manifest, candidates, { runner, posture: options.posture });
  const assertedCommit = options.asserted?.SOURCE_COMMIT?.trim(), assertedAccount = options.asserted?.OBSERVED_AWS_ACCOUNT_ID?.trim();
  if (assertedCommit && assertedCommit !== observation.sourceCommit) throw new QualificationTargetManifestError("target_source_mismatch", "asserted");
  if (assertedAccount && assertedAccount !== observation.awsAccountId) throw new QualificationTargetManifestError("target_account_refused", "asserted");
  return { ...observation, clean: true, sha256: boundaryDigest(observation) };
}

/** Two commands of one run (the recording fixture, then the run) must see one deployment. The first prints its
 * boundary digest; the second refuses before its first request when its own observation has another. No digest (a run
 * given an existing encounter, with no fixture before it) binds nothing. */
export function assertBoundaryUnchangedSince(observation: AcceptanceBoundarySnapshot, previousDigest: string | undefined): void {
  const previous = previousDigest?.trim();
  if (!previous) return;
  if (previous !== observation.sha256) throw new QualificationTargetManifestError("target_changed_between_steps", "fixture");
}
