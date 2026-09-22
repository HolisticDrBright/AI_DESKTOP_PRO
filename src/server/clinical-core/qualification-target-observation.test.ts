import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateQualificationTargetManifest, type QualificationTargetManifest } from "./qualification-target-manifest";
import { EXPORT_ACCEPTANCE_CANDIDATES, observeQualificationTarget } from "./qualification-target-observation";

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

type Recorded = { git?: string; account?: string; stacks?: Record<string, string>; failOn?: string };
const runner = (recorded: Recorded, m: QualificationTargetManifest) => (file: string, args: string[]) => {
  if (file === recorded.failOn) throw new Error("command_failed");
  if (file === "git") return `${recorded.git ?? m.sourceCommit}\n`;
  if (args[0] === "sts") return `${recorded.account ?? m.awsAccountId}\n`;
  const name = args[args.indexOf("--stack-name") + 1];
  const supplied = recorded.stacks?.[name];
  if (supplied !== undefined) return supplied;
  if (name === m.foundationStackName) return foundationStack;
  return candidateStack(m);
};
const observe = (recorded: Recorded = {}, m = manifest()) => observeQualificationTarget(m, EXPORT_ACCEPTANCE_CANDIDATES, { runner: runner(recorded, m) });

describe("observing the qualification target from the command line", () => {
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
