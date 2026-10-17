if (typeof window !== "undefined") throw new Error("clinical-core/qualification-target-boundary is server-only.");
import { createHash } from "node:crypto";
import { QualificationTargetManifestError } from "./qualification-target-manifest";

/**
 * The source boundary of a hosted acceptance run. The shared-manifest CLIs used to look at the target once, before the
 * run, and never at the working tree: a run from an edited checkout at the right HEAD, or one whose candidate stacks
 * were redeployed while it ran, still produced an acceptance verdict. An acceptance run is now bracketed by two
 * observations at safe boundaries (before its first request or fixture write, and after its last request), each of a
 * clean checkout at the manifest's exact commit and of every candidate stack it depends on, fingerprinted. The verdict
 * qualifies only when both observations succeed and agree.
 *
 * What this does not see (docs/hosted-acceptance-source-boundary-2026-10-17.md): a change outside CloudFormation, such
 * as a function's code replaced directly, leaves a stack's fingerprint as it was; and a change that is made and fully
 * reverted between the two observations is still a change CloudFormation records (LastUpdatedTime moves), but a direct
 * edit reverted in that window is not. Two reads are not an atomic snapshot.
 */
export type QualificationStackFingerprint = {
  candidate: string; stackName: string; stackStatus: string;
  stackId: string | null; creationTime: string | null; lastUpdatedTime: string | null;
  /** The stack's SourceCommit output, as it was read (the observer has already compared it with the manifest). */
  sourceCommit: string | null;
  /** SHA-256 over the canonical StackId, status, both times, and every output and parameter. */
  sha256: string;
};
export type ObservedQualificationTarget = {
  source: "observed"; awsAccountId: string; sourceCommit: string;
  foundation: QualificationStackFingerprint;
  stacks: QualificationStackFingerprint[];
};
/** One observation at a boundary: the target as observed, from a checkout that `git status` reported clean. */
export type AcceptanceBoundarySnapshot = ObservedQualificationTarget & { clean: true; sha256: string };
export type AcceptanceBoundaryInput = { before: AcceptanceBoundarySnapshot; after: () => AcceptanceBoundarySnapshot };
export type AcceptanceSourceBoundary = {
  schemaVersion: "acceptance-source-boundary/1";
  mode: "acceptance" | "exploratory";
  /** `unchanged`: both observations succeeded and agree. `changed`: they disagree. `refused`: the closing observation
   * refused (a stack mid-update, from another commit or gone; a dirty or moved checkout). `not_observed`: no boundary
   * (an exploratory run, which takes asserted values and is never acceptance evidence). */
  state: "unchanged" | "changed" | "refused" | "not_observed";
  source: "observed" | "asserted_by_caller";
  before: AcceptanceBoundarySnapshot | null;
  after: AcceptanceBoundarySnapshot | null;
  /** What differed: `source`, `account`, `foundation` or candidate names. */
  changed: string[];
  refusal: string | null;
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Fingerprints one described stack. Outputs and parameters are compared whole, so any update that changes them, and
 * any CloudFormation update at all (LastUpdatedTime moves), changes the fingerprint. */
export function fingerprintStack(candidate: string, stackName: string, stack: { status: string; stackId?: unknown; creationTime?: unknown; lastUpdatedTime?: unknown;
  outputs: Record<string, string | undefined>; parameters: Record<string, string | undefined> }): QualificationStackFingerprint {
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const identity = { stackName, stackId: text(stack.stackId), status: stack.status, creationTime: text(stack.creationTime), lastUpdatedTime: text(stack.lastUpdatedTime),
    outputs: stack.outputs, parameters: stack.parameters };
  return { candidate, stackName, stackStatus: stack.status, stackId: identity.stackId, creationTime: identity.creationTime, lastUpdatedTime: identity.lastUpdatedTime,
    sourceCommit: text(stack.outputs.SourceCommit), sha256: sha256(canonicalJson(identity)) };
}

/** The digest one boundary observation is known by: the account, the commit and every fingerprint, in candidate order.
 * The recording fixture prints it, and the run that follows refuses a deployment with another one. */
export function boundaryDigest(observation: ObservedQualificationTarget): string {
  return sha256(canonicalJson({ awsAccountId: observation.awsAccountId, sourceCommit: observation.sourceCommit, foundation: observation.foundation.sha256,
    stacks: observation.stacks.map((s) => [s.candidate, s.stackName, s.sha256]) }));
}

/** Everything that differs between two boundary observations; empty when they agree. */
export function compareAcceptanceBoundaries(before: ObservedQualificationTarget, after: ObservedQualificationTarget): string[] {
  const changed: string[] = [];
  if (before.sourceCommit !== after.sourceCommit) changed.push("source");
  if (before.awsAccountId !== after.awsAccountId) changed.push("account");
  if (before.foundation.sha256 !== after.foundation.sha256) changed.push("foundation");
  const candidates = [...new Set([...before.stacks.map((s) => s.candidate), ...after.stacks.map((s) => s.candidate)])];
  for (const candidate of candidates) {
    const a = before.stacks.find((s) => s.candidate === candidate), b = after.stacks.find((s) => s.candidate === candidate);
    if (!a || !b || a.stackName !== b.stackName || a.sha256 !== b.sha256) changed.push(candidate);
  }
  return changed;
}

export function boundaryRefusal(error: unknown): string {
  return error instanceof QualificationTargetManifestError ? `${error.category}${error.field ? `:${error.field}` : ""}` : "boundary_observation_failed";
}

/** Closes the boundary after the run's last request. Never throws: a closing observation that refuses is recorded as
 * `refused`, because the report is still written and must say why it does not qualify. */
export function closeAcceptanceBoundary(mode: "acceptance" | "exploratory", boundary?: AcceptanceBoundaryInput): AcceptanceSourceBoundary {
  const record = (fields: Pick<AcceptanceSourceBoundary, "state" | "before" | "after" | "changed" | "refusal">): AcceptanceSourceBoundary =>
    ({ schemaVersion: "acceptance-source-boundary/1", mode, source: boundary ? "observed" : "asserted_by_caller", ...fields });
  if (!boundary) return record({ state: "not_observed", before: null, after: null, changed: [], refusal: null });
  let after: AcceptanceBoundarySnapshot;
  try { after = boundary.after(); } catch (error) { return record({ state: "refused", before: boundary.before, after: null, changed: [], refusal: boundaryRefusal(error) }); }
  const changed = compareAcceptanceBoundaries(boundary.before, after);
  if (boundary.before.sha256 !== boundaryDigest(boundary.before) || after.sha256 !== boundaryDigest(after)) changed.push("digest");
  return record({ state: changed.length ? "changed" : "unchanged", before: boundary.before, after, changed, refusal: changed.length ? "target_changed_mid_run" : null });
}

/** The hosted verdict. A run qualifies only in acceptance mode, with every mandatory case passed on attributable
 * evidence (`ok`), and with the source boundary observed and unchanged around it. Exploratory runs never qualify. */
export function qualifiedVerdict(mode: "acceptance" | "exploratory", ok: boolean, boundary: AcceptanceSourceBoundary): boolean {
  return mode === "acceptance" && ok && boundary.state === "unchanged";
}

/** Whether a boundary lets `ok` stand: an unobserved boundary leaves the library's verdict as it was (and unqualified);
 * an observed one must be unchanged. */
export function boundaryAllowsOk(boundary: AcceptanceSourceBoundary): boolean {
  return boundary.state === "unchanged" || boundary.state === "not_observed";
}

/** The one-line form a CLI prints; the report file keeps both observations whole. */
export function boundarySummary(boundary: AcceptanceSourceBoundary): { state: AcceptanceSourceBoundary["state"]; changed: string[]; refusal: string | null; before: string | null; after: string | null } {
  return { state: boundary.state, changed: boundary.changed, refusal: boundary.refusal, before: boundary.before?.sha256 ?? null, after: boundary.after?.sha256 ?? null };
}
