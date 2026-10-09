import { describe, expect, it } from 'vitest';
import { embeddedMetrics, retentionSweepConfigurationFromEnv, runRetentionSweep, type RetentionSweepResult } from './privacy-retention-sweep-lambda';
import type { ClinicalCoreDatabase } from './database';

const result: RetentionSweepResult = {
  ok: true, refused: null, cleanup: { cleaned: 1, remaining: 0, deferred: 0 }, reconcile: null, backlog: null,
  run: { startedAt: '2026-09-28T00:00:00Z', endedAt: '2026-09-28T00:00:01Z', durationMs: 1000, examined: 1, removed: 1, outcome: 'completed' },
};

describe('retention metrics isolation', () => {
  it('publishes no unscoped series and separates deployments without patient or request dimensions', () => {
    const a = embeddedMetrics(result, 'fixture-a-privacy-retention-sweep');
    const b = embeddedMetrics(result, 'fixture-b-privacy-retention-sweep');
    expect(a.FunctionName).not.toBe(b.FunctionName);
    for (const metric of [a, b]) {
      expect(metric._aws.CloudWatchMetrics[0].Dimensions).toEqual([['FunctionName']]);
      expect(metric).toMatchObject({ SweepCompleted: 1, SweepFailed: 0, SweepRefused: 0 });
    }
  });
  it('does not count a failed or refused sweep as a heartbeat success', () => {
    for (const outcome of ['failed', 'refused'] as const) {
      const metric = embeddedMetrics({ ...result, ok: false, refused: outcome === 'refused' ? 'retention_service_release_required' : null, run: { ...result.run, outcome } }, 'fixture-retention');
      expect(metric.SweepCompleted).toBe(0);
      expect(metric.SweepFailed).toBe(outcome === 'failed' ? 1 : 0);
      expect(metric.SweepRefused).toBe(outcome === 'refused' ? 1 : 0);
    }
  });
  it('requires the Lambda-provided name before database or storage work', async () => {
    const configuration = retentionSweepConfigurationFromEnv({ NODE_ENV: 'test', AWS_LAMBDA_FUNCTION_NAME: 'fixture-retention' });
    expect(configuration.functionName).toBe('fixture-retention');
    let queried = false;
    const database: ClinicalCoreDatabase = { transaction: async () => { queried = true; throw new Error('unexpected database access'); } };
    for (const name of [undefined, '', 'a'.repeat(65), 'patient@example.invalid', 'unsafe\nname']) {
      await expect(runRetentionSweep(database, { enabled: false, phiAllowed: false, functionName: name })).rejects.toThrow('retention_metric_scope_invalid');
    }
    expect(queried).toBe(false);
  });
});
