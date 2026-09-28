import { beforeAll,describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Verify deployed cadence and monitoring structure, not a deletion guarantee.
 * The download cutoff, sweep cadence and public removal commitment have different anchors.
 * Comparing three constants cannot establish that storage is removed on time.
 */
const SWEEP_HOURS = 24;

let resources:Record<string, { Type: string; Properties: Record<string, unknown> }>;
beforeAll(()=>{
  execFileSync(process.execPath, ["scripts/build-aws-privacy-operations.mjs"], { stdio: "pipe",timeout:60_000 });
  resources=JSON.parse(readFileSync("dist/aws-clinical-core/privacy-operations/template.json", "utf8")).Resources;
},65_000);

describe("the retention cadence", () => {
  it("sweeps every 24 hours", () => {
    expect(resources.RetentionSweepSchedule.Properties.ScheduleExpression).toBe(`rate(${SWEEP_HOURS} hours)`);
  });

  it("documents the download cutoff separately from unverified removal commitments", () => {
    const runbook = readFileSync("docs/retention-sweep-activation-runbook.md", "utf8");
    expect(runbook).toContain("**48 hours**");
    expect(runbook).toContain("**72 hours**");
    expect(runbook).toContain("not a deletion guarantee");
    const migration = readFileSync('infra/aws-clinical-core/production-migrations/20260920110000_production_owned_privacy_export_jobs.sql', 'utf8');
    expect(migration).toContain("_as_of+interval '48 hours'");
  });

  it('separates each deployment and distinguishes daily silence from an observed refusal', () => {
    for (const alarm of ['RetentionOverdueAlarm', 'RetentionRefusedAlarm', 'RetentionSweepMissedAlarm', 'RetentionSweepConsecutiveFailureAlarm']) {
      expect(resources[alarm].Properties.Dimensions).toEqual([{ Name: 'FunctionName', Value: { Ref: 'RetentionSweep' } }]);
    }
    for (const alarm of ['RetentionOverdueAlarm', 'RetentionRefusedAlarm']) {
      expect(resources[alarm].Properties).toMatchObject({ Period: 3600, TreatMissingData: 'notBreaching' });
    }
    expect(resources.RetentionSweepMissedAlarm.Properties).toMatchObject({ MetricName: 'SweepCompleted', Statistic: 'Sum', Period: 86400, Threshold: 1, ComparisonOperator: 'LessThanThreshold', TreatMissingData: 'breaching' });
  });

  it("runs under its own role and reports every run, with alarms for missed, errored and twice-failed", () => {
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
