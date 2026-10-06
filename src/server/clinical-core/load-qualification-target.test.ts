import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLoadQualificationTarget } from "./load-qualification-target";

const command = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: command }));
const directory = mkdtempSync(join(tmpdir(), "alp-load-target-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const target = {
  ...JSON.parse(readFileSync("infra/aws-clinical-core/qualification-target.example.json", "utf8")),
  databaseSecretArn: "arn:aws:secretsmanager:us-east-2:588966314750:secret:fictional-qualification-AbCdEf",
  sourceCommit: "a".repeat(40), migrationReleaseHash: "b".repeat(64),
  identitySubjects: { consumer: "consumer-fictional-0001", workforce: "workforce-fictional-0001", foreignConsumer: "consumer-fictional-0002" },
};
const file = join(directory, "target.json");
writeFileSync(file, JSON.stringify(target));
function stack(foundation: boolean, overrides: Record<string, string> = {}) {
  return JSON.stringify({ StackStatus: "CREATE_COMPLETE",
    Outputs: Object.entries({ PhiAllowed: "false", Activation: "blocked", QualificationExecution: foundation ? "disabled" : "enabled", SourceCommit: target.sourceCommit, ApiId: target.apiId })
      .map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    Parameters: Object.entries({ DatabaseClusterArn: target.databaseClusterArn, DatabaseSecretArn: target.databaseSecretArn,
      DatabaseName: target.databaseName, QualificationAccountId: target.awsAccountId, ApiId: target.apiId, ClinicalApiId: target.apiId,
      ExportBucketName: target.exportBucket, SourceCommit: target.sourceCommit, QualificationIdentitySubjects: Object.values(target.identitySubjects).join(","), ...overrides })
      .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
  });
}
const observed = (file: string, args: string[]) => {
  if (file === "git") return args[0] === "status" ? "" : target.sourceCommit;
  if (args[0] === "sts") return JSON.stringify({ Account: target.awsAccountId, Arn: `arn:aws:sts::${target.awsAccountId}:assumed-role/QualificationOperator/fictional-session` });
  return stack(args[args.indexOf("--stack-name") + 1] === target.foundationStackName);
};
beforeEach(() => { command.mockReset(); command.mockImplementation(observed); });

describe("load target binding reuses live qualification observations", () => {
  it("observes STS, source and both serving candidate stacks, not just the URL", () => {
    const evidence = inspectLoadQualificationTarget(file, target.apiOrigin);
    expect(evidence.activationEvidence).toBe(false);
    expect(evidence.positiveClinicalAcceptance).toBe(false);
    expect(evidence.observation.source).toBe("observed");
    expect(evidence.observation.stacks.map(row => row.candidate)).toEqual(["personal-storage", "owned-lab"]);
    expect(command.mock.calls.some(([, args]) => args[0] === "sts")).toBe(true);
  });
  it("refuses a different execute-api origin before AWS inspection", () => {
    expect(() => inspectLoadQualificationTarget(file, "https://abcdefghij.execute-api.us-east-2.amazonaws.com"))
      .toThrow("load_target_origin_mismatch");
    expect(command).not.toHaveBeenCalled();
  });
  it("refuses a dirty source checkout before AWS inspection", () => {
    command.mockReturnValue(" M source.ts");
    expect(() => inspectLoadQualificationTarget(file, target.apiOrigin)).toThrow("load_source_dirty");
    expect(command).toHaveBeenCalledTimes(1);
  });
  it("refuses wrong account and wrong source observations", () => {
    command.mockImplementation((file, args) => args[0] === "sts" ? JSON.stringify({ Account: "173535830222", Arn: "arn:aws:sts::173535830222:assumed-role/Other/fictional-session" }) : observed(file, args));
    expect(() => inspectLoadQualificationTarget(file, target.apiOrigin)).toThrow("target_account_refused");
    command.mockImplementation((file, args) => args[0] === "rev-parse" ? "c".repeat(40) : observed(file, args));
    expect(() => inspectLoadQualificationTarget(file, target.apiOrigin)).toThrow("target_source_mismatch");
  });
  it("refuses a stack mapped to the old staging database", () => {
    command.mockImplementation((file, args) => args.includes(target.stacks["owned-lab"])
      ? stack(false, { DatabaseName: "clinical_core" }) : observed(file, args));
    expect(() => inspectLoadQualificationTarget(file, target.apiOrigin)).toThrow("target_stack_refused");
  });
});
