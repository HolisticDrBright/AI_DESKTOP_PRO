import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateQualificationTargetManifest, type QualificationTargetManifest } from "./qualification-target-manifest";
import { EXPORT_ACCEPTANCE_CANDIDATES, RECORDING_ACCEPTANCE_CANDIDATES, assertBoundaryUnchangedSince, observeAcceptanceBoundary, observeQualificationTarget } from "./qualification-target-observation";
import { closeAcceptanceBoundary, compareAcceptanceBoundaries } from "./qualification-target-boundary";
import { FICTIONAL_ACCOUNT, FICTIONAL_COMMIT, FictionalQualificationDeployment, fictionalQualificationManifest } from "./testing/qualification-target-fictional";

// A fictional deployment answered by a recorded `aws`/`git`: no AWS call, no credential, no request.
const example = JSON.parse(readFileSync("infra/aws-clinical-core/qualification-target.example.json", "utf8")) as Record<string, unknown>;
const commit = "a".repeat(40);
const manifest = (): QualificationTargetManifest => validateQualificationTargetManifest({ ...example, exportBucket: "alp-qualification-exports-588966314750-us-east-2",
  recordingBucket: "alp-qualification-recordings-588966314750-us-east-2", databaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf",
  sourceCommit: commit, migrationReleaseHash: "b".repeat(64),
  identitySubjects: { consumer: "11111111-2222-4333-8444-555555555555", workforce: "66666666-7777-4888-8999-000000000000", foreignConsumer: "22222222-3333-4444-8555-666666666666" } });
const subjects = "11111111-2222-4333-8444-555555555555,66666666-7777-4888-8999-000000000000,22222222-3333-4444-8555-666666666666";
const candidateStack = (m: QualificationTargetManifest, patch: Record<string, string | undefined> = {}, status = "CREATE_COMPLETE") => JSON.stringify({
  StackStatus: status,
  Outputs: [{ OutputKey: "PhiAllowed", OutputValue: "false" }, { OutputKey: "Activation", OutputValue: "blocked" }, { OutputKey: "QualificationExecution", OutputValue: "enabled" }, { OutputKey: "SourceCommit", OutputValue: m.sourceCommit }],
  Parameters: Object.entries({ DatabaseClusterArn: m.databaseClusterArn, DatabaseSecretArn: m.databaseSecretArn, DatabaseName: m.databaseName, QualificationAccountId: m.awsAccountId,
    ApiId: m.apiId, ExportBucketName: m.exportBucket, RecordingBucket: m.recordingBucket, SourceCommit: m.sourceCommit, QualificationIdentitySubjects: subjects, ...patch })
    .filter(([, value]) => value !== undefined).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
});
const foundationStack = JSON.stringify({ StackStatus: "CREATE_COMPLETE", Parameters: [], Outputs: [{ OutputKey: "PhiAllowed", OutputValue: "false" }, { OutputKey: "ApiId", OutputValue: "6zt8e9qz04" },
  { OutputKey: "QualificationExecution", OutputValue: "disabled" }] });

type Recorded = { git?: string; account?: string; principal?: string; stsResponse?: string; stacks?: Record<string, string>; failOn?: string };
const runner = (recorded: Recorded, m: QualificationTargetManifest) => (file: string, args: string[]) => {
  if (file === recorded.failOn) throw new Error("command_failed");
  if (file === "git") return `${recorded.git ?? m.sourceCommit}\n`;
  if (args[0] === "sts") return recorded.stsResponse ?? JSON.stringify({ Account: recorded.account ?? m.awsAccountId,
    Arn: recorded.principal ?? `arn:aws:sts::${m.awsAccountId}:assumed-role/QualificationOperator/fictional-session` });
  const name = args[args.indexOf("--stack-name") + 1];
  const supplied = recorded.stacks?.[name];
  if (supplied !== undefined) return supplied;
  if (name === m.foundationStackName) return foundationStack;
  return candidateStack(m);
};
const observe = (recorded: Recorded = {}, m = manifest()) => observeQualificationTarget(m, EXPORT_ACCEPTANCE_CANDIDATES, { runner: runner(recorded, m) });

describe("observing the qualification target from the command line", () => {
  test("messaging observation refuses a historical target or a missing/wrong live migration release", () => {
    const old = manifest();
    expect(() => observeQualificationTarget(old, ["care-messaging"], { runner: runner({}, old) })).toThrow("target_stack_refused");
    const m = validateQualificationTargetManifest({ ...old, schemaVersion: "aws-clinical-core-qualification-target/2", stacks: { ...old.stacks, "care-messaging": "ai-clinical-core-qualification-care-messaging" } });
    const parsed = JSON.parse(candidateStack(m)) as { Outputs: Array<{OutputKey: string; OutputValue: string}>; Parameters: Array<{ParameterKey: string; ParameterValue: string}> };
    parsed.Outputs.push({ OutputKey: "MigrationReleaseSha256", OutputValue: m.migrationReleaseHash }, { OutputKey: "DatabaseName", OutputValue: m.databaseName });
    parsed.Parameters.push({ ParameterKey: "MigrationReleaseSha256", ParameterValue: m.migrationReleaseHash });
    const check = () => observeQualificationTarget(m, ["care-messaging"], { runner: runner({ stacks: { [m.stacks["care-messaging"]]: JSON.stringify(parsed) } }, m) });
    expect(check().stacks).toHaveLength(1);
    parsed.Outputs.find(p => p.OutputKey === "MigrationReleaseSha256")!.OutputValue = "c".repeat(64);
    expect(check).toThrow("target_stack_refused");
    parsed.Outputs.find(p => p.OutputKey === "MigrationReleaseSha256")!.OutputValue = m.migrationReleaseHash;
    parsed.Parameters = parsed.Parameters.filter(p => p.ParameterKey !== "MigrationReleaseSha256");
    expect(check).toThrow("target_stack_refused");
  });
  test("the run looks at the live account, the checkout and every candidate stack it depends on", () => {
    const observation = observe();
    expect(observation).toMatchObject({ source: "observed", awsAccountId: "588966314750", sourceCommit: commit });
    expect(observation.stacks.map((s) => s.candidate)).toEqual(["personal-storage", "privacy-operations"]);
    expect(observation.stacks.every((s) => s.stackStatus === "CREATE_COMPLETE")).toBe(true);
  });
  test("an asserted account or commit cannot stand in for the observation: the live values decide", () => {
    // These are exactly the values the earlier CLI took from the environment; here they come from the account and checkout.
    expect(() => observe({ account: "111111111111" })).toThrow("target_account_refused");
    expect(() => observe({ account: "173535830222" })).toThrow("target_account_refused");
    expect(() => observe({ git: "c".repeat(40) })).toThrow("target_source_mismatch");
    expect(() => observe({ failOn: "git" })).toThrow("target_source_mismatch");
    expect(() => observe({ failOn: "aws" })).toThrow("target_account_refused");
  });
  test("a matching account root or IAM user is not an acceptable qualification operator", () => {
    expect(() => observe({ principal: "arn:aws:iam::588966314750:root" })).toThrow("target_account_refused");
    expect(() => observe({ principal: "arn:aws:iam::588966314750:user/long-lived" })).toThrow("target_account_refused");
    expect(() => observe({ stsResponse: "not-json" })).toThrow("target_account_refused");
    expect(() => observe({ stsResponse: JSON.stringify({ Account: "588966314750" }) })).toThrow("target_account_refused");
  });
  test("a missing, unfinished, wrongly posed or wrongly resourced candidate stack stops the run before the first request", () => {
    const m = manifest();
    const stack = (patch: Record<string, string | undefined>, status?: string) => ({ stacks: { [m.stacks["personal-storage"]]: candidateStack(m, patch, status) } });
    expect(() => observe({ stacks: { [m.stacks["personal-storage"]]: "" } })).toThrow("target_stack_refused");
    expect(() => observe({ stacks: { [m.stacks["personal-storage"]]: "not json" } })).toThrow("target_stack_refused");
    expect(() => observe(stack({}, "UPDATE_IN_PROGRESS"))).toThrow("target_stack_refused");
    expect(() => observe(stack({ DatabaseClusterArn: "arn:aws:rds:us-east-2:588966314750:cluster:other" }))).toThrow("target_stack_refused");
    expect(() => observe(stack({ DatabaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:other" }))).toThrow("target_stack_refused");
    expect(() => observe(stack({ ExportBucketName: "other-bucket" }))).toThrow("target_stack_refused");
    expect(() => observe(stack({ DatabaseName: "clinical_core" }))).toThrow("target_stack_refused");
    expect(() => observe(stack({ ApiId: "wxv734oi12" }))).toThrow("target_stack_refused");
    expect(() => observe(stack({ QualificationIdentitySubjects: "11111111-2222-4333-8444-555555555555" }))).toThrow("target_stack_refused");
  });
  test("the qualification foundation must state PHI false and agree where it names the API; its disabled execution output is not candidate evidence", () => {
    const m = manifest();
    expect(() => observe({ stacks: { [m.foundationStackName]: JSON.stringify({ StackStatus: "CREATE_COMPLETE", Outputs: [{ OutputKey: "PhiAllowed", OutputValue: "true" }] }) } })).toThrow("target_stack_refused");
    expect(() => observe({ stacks: { [m.foundationStackName]: JSON.stringify({ StackStatus: "CREATE_COMPLETE", Outputs: [{ OutputKey: "PhiAllowed", OutputValue: "false" }, { OutputKey: "ApiId", OutputValue: "wxv734oi12" }] }) } })).toThrow("target_stack_refused");
    expect(observe().stacks).toHaveLength(2);
  });
});

describe("the acceptance source boundary: a clean exact checkout and the same deployment before and after the run", () => {
  // A fictional deployment (testing/qualification-target-fictional.ts): fictional account, stacks and commit, answered
  // through the observer's own runner. Not hosted evidence.
  const setup = (drain: string[] = []) => {
    const m = fictionalQualificationManifest(), d = new FictionalQualificationDeployment(m, drain);
    const observe = (candidates: readonly string[] = EXPORT_ACCEPTANCE_CANDIDATES, options: Parameters<typeof observeAcceptanceBoundary>[2] = {}) =>
      observeAcceptanceBoundary(m, candidates, { runner: d.runner, ...options });
    return { m, d, observe };
  };
  test("an observation fingerprints each stack it read, the foundation included, so a later read can be compared with it", () => {
    const { m, d } = setup();
    const observation = observeQualificationTarget(m, EXPORT_ACCEPTANCE_CANDIDATES, { runner: d.runner });
    expect(observation.foundation).toMatchObject({ candidate: "foundation", stackName: m.foundationStackName, stackStatus: "CREATE_COMPLETE" });
    expect(observation.stacks[0]).toMatchObject({ candidate: "personal-storage", stackName: m.stacks["personal-storage"], sourceCommit: m.sourceCommit, lastUpdatedTime: null,
      stackId: expect.stringContaining(":stack/fictional-qualification-personal-storage/") });
    for (const fingerprint of [observation.foundation, ...observation.stacks]) expect(fingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(observation.stacks.map((s) => s.sha256)).size).toBe(2);
  });
  test("a dirty checkout is refused before any AWS call, whatever HEAD says", () => {
    const { d, observe } = setup();
    d.status = " M src/server/clinical-core/recording-acceptance.ts\n";
    expect(() => observe()).toThrow("target_source_dirty");
    d.status = "?? stray-local-file.json\n";
    expect(() => observe()).toThrow("target_source_dirty");
    expect(d.awsCalls()).toBe(0);
    d.status = "";
    expect(observe()).toMatchObject({ clean: true, sourceCommit: FICTIONAL_COMMIT });
  });
  test("a stale checkout, a missing stack and an asserted value that disagrees with the observation are refused", () => {
    const { d, observe } = setup();
    d.head = "c".repeat(40);
    expect(() => observe()).toThrow("target_source_mismatch");
    d.head = FICTIONAL_COMMIT;
    // SOURCE_COMMIT and OBSERVED_AWS_ACCOUNT_ID are what the wrapper saw; a disagreement means the checkout or the
    // signed-in account changed between the two steps, and it is refused rather than silently overridden.
    expect(() => observe(EXPORT_ACCEPTANCE_CANDIDATES, { asserted: { SOURCE_COMMIT: "c".repeat(40) } })).toThrow("target_source_mismatch");
    expect(() => observe(EXPORT_ACCEPTANCE_CANDIDATES, { asserted: { OBSERVED_AWS_ACCOUNT_ID: "444455556666" } })).toThrow("target_account_refused");
    expect(observe(EXPORT_ACCEPTANCE_CANDIDATES, { asserted: { SOURCE_COMMIT: FICTIONAL_COMMIT, OBSERVED_AWS_ACCOUNT_ID: FICTIONAL_ACCOUNT } }).clean).toBe(true);
    d.remove("privacy-operations");
    expect(() => observe()).toThrow("target_stack_refused");
  });
  test("the same deployment before and after is unchanged; a redeploy in between is a change even when SourceCommit stays the same", () => {
    const { d, observe } = setup();
    const before = observe();
    expect(closeAcceptanceBoundary("acceptance", { before, after: () => observe() })).toMatchObject({ state: "unchanged", changed: [], refusal: null, source: "observed" });
    // A mid-run redeploy of the same commit (a new code version, the same SourceCommit) still changes the stack.
    d.redeploy("privacy-operations", { parameters: { CodeVersion: "fictional-code-version-2" } });
    const redeployed = closeAcceptanceBoundary("acceptance", { before, after: () => observe() });
    expect(redeployed).toMatchObject({ state: "changed", changed: ["privacy-operations"], refusal: "target_changed_mid_run" });
    expect(redeployed.after?.stacks.find((s) => s.candidate === "privacy-operations")?.sourceCommit).toBe(FICTIONAL_COMMIT);
    expect(compareAcceptanceBoundaries(before, observe())).toEqual(["privacy-operations"]);
  });
  test("a stack that is mid-update, redeployed from another commit or gone at the closing boundary refuses the report", () => {
    for (const change of [(d: FictionalQualificationDeployment) => d.redeploy("personal-storage", { status: "UPDATE_IN_PROGRESS" }),
      (d: FictionalQualificationDeployment) => d.redeploy("personal-storage", { outputs: { SourceCommit: "c".repeat(40) }, parameters: { SourceCommit: "c".repeat(40) } }),
      (d: FictionalQualificationDeployment) => d.remove("personal-storage")]) {
      const { d, observe } = setup(), before = observe();
      change(d);
      expect(closeAcceptanceBoundary("acceptance", { before, after: () => observe() })).toMatchObject({ state: "refused", refusal: "target_stack_refused:personal-storage", after: null });
    }
  });
  test("the checkout changing during the run refuses the report too: a new HEAD or an edited file", () => {
    const { d, observe } = setup(), before = observe();
    d.status = " M src/server/clinical-core/export-retention-acceptance.ts\n";
    expect(closeAcceptanceBoundary("acceptance", { before, after: () => observe() })).toMatchObject({ state: "refused", refusal: "target_source_dirty:checkout" });
    d.status = ""; d.head = "d".repeat(40);
    expect(closeAcceptanceBoundary("acceptance", { before, after: () => observe() })).toMatchObject({ state: "refused", refusal: "target_source_mismatch:checkout" });
  });
  test("a step that observed another deployment than the one before it is refused (the fixture and the run of one recording acceptance)", () => {
    const { d, observe } = setup(), fixture = observe(RECORDING_ACCEPTANCE_CANDIDATES);
    expect(() => assertBoundaryUnchangedSince(observe(RECORDING_ACCEPTANCE_CANDIDATES), fixture.sha256)).not.toThrow();
    expect(() => assertBoundaryUnchangedSince(observe(RECORDING_ACCEPTANCE_CANDIDATES), undefined)).not.toThrow();
    d.redeploy("recording-transcription");
    expect(() => assertBoundaryUnchangedSince(observe(RECORDING_ACCEPTANCE_CANDIDATES), fixture.sha256)).toThrow("target_changed_between_steps");
    expect(() => assertBoundaryUnchangedSince(fixture, "not-a-digest")).toThrow("target_changed_between_steps");
  });
  test("a drain-posture boundary observes the draining voice candidate; an exploratory run is never observed and never acceptance evidence", () => {
    const { observe } = setup(["owned-voice"]);
    expect(observe(["owned-voice"], { posture: "drain" }).stacks).toHaveLength(1);
    expect(() => observe(["owned-voice"])).toThrow("target_stack_refused");
    expect(closeAcceptanceBoundary("exploratory")).toMatchObject({ state: "not_observed", source: "asserted_by_caller", before: null, after: null });
    expect(closeAcceptanceBoundary("acceptance")).toMatchObject({ state: "not_observed" });
  });
});
