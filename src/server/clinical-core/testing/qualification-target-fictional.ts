import { QUALIFICATION_STACK_SPECS, designatedSubjects, validateQualificationTargetManifest, type QualificationTargetManifest } from "../qualification-target-manifest";

/**
 * A fictional qualification deployment, answered through the observer's injectable runner (or a mocked `execFileSync`).
 * Every value is fictional: the account, the stack names, the commit, the API id and the subjects. No AWS call, no
 * credential and no request is made, and nothing here is hosted evidence: it models what `git` and the AWS CLI would
 * print, so the real observer, the real acceptance libraries and the real CLIs can be driven against it.
 */
export const FICTIONAL_COMMIT = "a".repeat(40);
export const FICTIONAL_ACCOUNT = "111122223333";
export const FICTIONAL_REGION = "us-east-2";
const LEGACY = ["personal-storage", "privacy-operations", "owned-lab", "owned-voice", "recording-authority", "recording-capture",
  "recording-transcription", "recording-drafting", "recording-cleanup-review", "recording-cleanup-execution"] as const;

export function fictionalQualificationManifest(patch: Record<string, unknown> = {}): QualificationTargetManifest {
  return validateQualificationTargetManifest({
    schemaVersion: "aws-clinical-core-qualification-target/1", environment: "synthetic-staging", dataClassification: "synthetic_only", containsPhi: false,
    awsAccountId: FICTIONAL_ACCOUNT, awsRegion: FICTIONAL_REGION, foundationStackName: "fictional-qualification-foundation",
    apiId: "fict000001", apiOrigin: `https://fict000001.execute-api.${FICTIONAL_REGION}.amazonaws.com`,
    databaseClusterArn: `arn:aws:rds:${FICTIONAL_REGION}:${FICTIONAL_ACCOUNT}:cluster:fictional-qualification-cluster`,
    databaseSecretArn: `arn:aws:secretsmanager:${FICTIONAL_REGION}:${FICTIONAL_ACCOUNT}:secret:fictional-qualification-AbCdEf`,
    databaseName: "clinical_core_qualification", exportBucket: "fictional-qualification-exports", recordingBucket: "fictional-qualification-recordings",
    sourceCommit: FICTIONAL_COMMIT, migrationReleaseHash: "b".repeat(64),
    identitySubjects: { consumer: "fictional-consumer-0001", workforce: "fictional-workforce-0001", foreignConsumer: "fictional-consumer-0002" },
    stacks: Object.fromEntries(LEGACY.map((candidate) => [candidate, `fictional-qualification-${candidate}`])),
    refused: { stagingFoundationStackName: "fictional-staging-foundation", stagingApiOrigin: `https://fict999999.execute-api.${FICTIONAL_REGION}.amazonaws.com`, stagingDatabaseName: "clinical_core" },
    reviewedAt: "2026-10-17T00:00:00Z",
    ...patch,
  });
}

export type FictionalStack = { status: string; stackId: string; creationTime: string; lastUpdatedTime?: string; outputs: Record<string, string>; parameters: Record<string, string> };

/** The deployment the fictional `git` and `aws` describe. Tests change it between and during runs to model a redeploy. */
export class FictionalQualificationDeployment {
  head = FICTIONAL_COMMIT;
  /** What `git status --porcelain --untracked-files=all` prints; empty is a clean checkout. */
  status = "";
  account = FICTIONAL_ACCOUNT;
  principal = `arn:aws:sts::${FICTIONAL_ACCOUNT}:assumed-role/FictionalQualificationOperator/fictional-session`;
  readonly stacks = new Map<string, FictionalStack>();
  readonly calls: Array<{ file: string; args: string[] }> = [];
  private clock = Date.parse("2026-10-17T06:00:00Z");

  constructor(readonly manifest: QualificationTargetManifest, drain: readonly string[] = []) {
    this.stacks.set(manifest.foundationStackName, this.stack(manifest.foundationStackName, { PhiAllowed: "false", ApiId: manifest.apiId, QualificationExecution: "disabled" }, {}));
    for (const [candidate, name] of Object.entries(manifest.stacks)) this.stacks.set(name, this.candidate(candidate, name, drain.includes(candidate)));
  }

  private stack(name: string, outputs: Record<string, string>, parameters: Record<string, string>): FictionalStack {
    return { status: "CREATE_COMPLETE", stackId: `arn:aws:cloudformation:${this.manifest.awsRegion}:${this.manifest.awsAccountId}:stack/${name}/00000000-0000-4000-8000-000000000001`,
      creationTime: "2026-10-16T00:00:00.000Z", outputs, parameters };
  }

  private candidate(candidate: string, name: string, drain: boolean): FictionalStack {
    const m = this.manifest, spec = QUALIFICATION_STACK_SPECS[candidate];
    const parameters: Record<string, string> = { DatabaseClusterArn: m.databaseClusterArn, DatabaseSecretArn: m.databaseSecretArn, DatabaseName: m.databaseName,
      QualificationAccountId: m.awsAccountId, SourceCommit: m.sourceCommit, QualificationIdentitySubjects: designatedSubjects(m.identitySubjects).join(","), CodeVersion: "fictional-code-version-1" };
    if (spec?.api) parameters[spec.api] = m.apiId;
    for (const bucket of spec?.buckets ?? []) parameters[bucket] = bucket === "ExportBucketName" ? m.exportBucket : m.recordingBucket;
    return this.stack(name, { PhiAllowed: "false", Activation: drain ? "draining" : "blocked", QualificationExecution: drain ? "disabled" : "enabled", SourceCommit: m.sourceCommit }, parameters);
  }

  /** A CloudFormation update of one candidate: its LastUpdatedTime moves, and the patch replaces what the update changed. */
  redeploy(candidate: string, patch: { outputs?: Record<string, string>; parameters?: Record<string, string>; status?: string } = {}): void {
    const name = this.manifest.stacks[candidate] ?? candidate, stack = this.stacks.get(name);
    if (!stack) throw new Error("fictional_stack_absent");
    this.clock += 60_000;
    stack.lastUpdatedTime = new Date(this.clock).toISOString();
    stack.status = patch.status ?? "UPDATE_COMPLETE";
    Object.assign(stack.outputs, patch.outputs ?? {});
    Object.assign(stack.parameters, patch.parameters ?? {});
  }

  remove(candidate: string): void { this.stacks.delete(this.manifest.stacks[candidate] ?? candidate); }

  awsCalls(): number { return this.calls.filter((call) => call.file === "aws").length; }

  /** Answers exactly the commands the observer runs; anything else is refused, so an unexpected command cannot pass silently. */
  readonly runner = (file: string, args: string[]): string => {
    this.calls.push({ file, args: [...args] });
    if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return `${this.head}\n`;
    if (file === "git" && args[0] === "status" && args.includes("--porcelain")) return this.status;
    if (file === "aws" && args[0] === "sts" && args[1] === "get-caller-identity") return JSON.stringify({ Account: this.account, Arn: this.principal, UserId: "fictional" });
    if (file === "aws" && args[0] === "cloudformation" && args[1] === "describe-stacks") {
      const name = args[args.indexOf("--stack-name") + 1], stack = this.stacks.get(name);
      if (!stack) throw new Error(`Stack with id ${name} does not exist`);
      return JSON.stringify({ StackId: stack.stackId, StackName: name, StackStatus: stack.status, CreationTime: stack.creationTime,
        ...(stack.lastUpdatedTime ? { LastUpdatedTime: stack.lastUpdatedTime } : {}),
        Outputs: Object.entries(stack.outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
        Parameters: Object.entries(stack.parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) });
    }
    throw new Error("fictional_command_unexpected");
  };
}
