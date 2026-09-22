import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Three numbers that nest: the sweep runs every 24 hours, the copy is removed at 48, and the published commitment is
 * 72. Each has slack against the next, and they live in different artifacts on purpose — the published one is weaker
 * than the implementation because publishing measured behaviour turns a timing bug into a misstatement. This does not
 * reconcile them; it holds each where it belongs and checks that they still nest.
 */
const SWEEP_HOURS = 24;
const IMPLEMENTED_HOURS = 48;
const PUBLISHED_HOURS = 72;

function template(): Record<string, { Type: string; Properties: Record<string, unknown> }> {
  execFileSync(process.execPath, ["scripts/build-aws-privacy-operations.mjs"], { stdio: "pipe" });
  return JSON.parse(readFileSync("dist/aws-clinical-core/privacy-operations/template.json", "utf8")).Resources;
}

describe("the retention cadence", () => {
  it("sweeps every 24 hours", () => {
    expect(template().RetentionSweepSchedule.Properties.ScheduleExpression).toBe(`rate(${SWEEP_HOURS} hours)`);
  });

  it("nests inside the implemented deadline, which nests inside the published commitment", () => {
    expect(SWEEP_HOURS).toBeLessThan(IMPLEMENTED_HOURS);
    expect(IMPLEMENTED_HOURS).toBeLessThan(PUBLISHED_HOURS);
    const runbook = readFileSync("docs/retention-sweep-activation-runbook.md", "utf8");
    expect(runbook).toContain("**48 hours**");
    expect(runbook).toContain("**72 hours**");
    expect(runbook).toContain("The published privacy policy, and nowhere else");
  });

  it("runs under its own role and reports every run, with alarms for missed, errored and twice-failed", () => {
    const resources = template();
    expect(resources.RetentionSweep.Properties.Role).toEqual({ "Fn::GetAtt": ["RetentionSweepRole", "Arn"] });
    const policies = resources.RetentionSweepRole.Properties.Policies as { PolicyName: string }[];
    expect(policies.map((policy) => policy.PolicyName).sort())
      .toEqual(["ReviewedRetentionSweepDatabase", "ReviewedRetentionSweepExports", "bounded-logs"]);
    for (const alarm of ["RetentionSweepMissedAlarm", "RetentionSweepFailedAlarm", "RetentionSweepConsecutiveFailureAlarm"]) {
      expect(resources[alarm]?.Type, alarm).toBe("AWS::CloudWatch::Alarm");
      expect(resources[alarm].Properties.AlarmActions).toEqual([{ Ref: "AlarmTopicArn" }]);
    }
    expect(resources.RetentionSweepConsecutiveFailureAlarm.Properties).toMatchObject({ EvaluationPeriods: 2, DatapointsToAlarm: 2 });
    expect(resources.RetentionSweepMissedAlarm.Properties).toMatchObject({ TreatMissingData: "breaching", Period: 86_400 });
  });
});
