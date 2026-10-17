import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ClinicalCoreDatabase } from './database';
import {
  RECONCILER_ATTEMPTS_PER_ITEM, RECONCILER_BATCH_LIMIT, RECONCILER_OUTAGE_STOP_AFTER, RECONCILER_OVERDUE_AFTER_MS, RECONCILER_RETRY_PAUSE_MS,
  RECONCILER_SCHEDULE_EXPRESSION, RECONCILER_SWEEP_BUDGET_MS, REVOCATION_SIGNAL_RECONCILER_ROLE, WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE,
  createSqlRevocationSignalReconcilerStore, runRevocationSignalReconciler,
  type DueRevocation, type ReconcilerAttempt, type ReconcilerSummary, type RevocationSignalReconcilerStore,
} from './revocation-signal-reconciler';
import { build, handler } from './revocation-signal-reconciler-lambda';
import { createDynamoStaffRevocationSignalPublisher } from './staff-revocation-signal';
import { WorkforceProviderFailure, type ProviderFailure } from './workforce-identity-revocation';
import { fictionalSignalTable } from '@/test-support/fictional-signal-table';

/**
 * The scheduled campaign-signal reconciler (BLOCKED), at its two boundaries: the reconciler's SQL store and the signal
 * writer, both fictional here. Before this change a revocation whose signal failed to publish was retried only by an
 * operator's reconciliation, so the campaign engine kept admitting the revoked login until an operator came back. The
 * reconciler retries it on a schedule, under a lease, from the revocation records themselves, and says when it is
 * overdue. Fictional subjects and ids only; no AWS call is made.
 */
const NOW = Date.parse('2026-10-17T12:00:00Z');
const due = (n: number, overrides: Partial<DueRevocation> = {}): DueRevocation => ({
  revocationId: `0e000000-0000-4000-8000-${String(n).padStart(12, '0')}`, subject: `fictional-workforce-subject-${String(n).padStart(4, '0')}`,
  revokedAt: new Date(NOW - 60_000).toISOString(), attempts: 0, lastAttemptAt: null, ...overrides,
});
/** A fictional store: the due list it was given, every call it saw, and the outcome it records. */
function fakeStore(items: DueRevocation[], options: { held?: boolean; record?: (attempt: ReconcilerAttempt, call: number) => Promise<'recorded' | 'duplicate' | 'lease_lost' | 'not_found' | 'subject_mismatch'> } = {}) {
  const calls: string[] = [];
  const recorded: ReconcilerAttempt[] = [];
  let records = 0;
  const unpublished = () => items.filter(item => !recorded.some(r => r.revocationId === item.revocationId && r.outcome === 'succeeded'));
  const status = () => ({ unpublished: unpublished().length, oldestUnpublishedAt: unpublished().map(i => i.revokedAt).sort()[0] ?? null, lastCompletedAt: null });
  const store: RevocationSignalReconcilerStore = {
    async claim(sweepId, limit) {
      calls.push(`claim:${limit ?? 'default'}`);
      expect(sweepId).toMatch(/^[0-9a-f-]{36}$/);
      if (options.held) return { granted: false, leaseUntil: new Date(NOW + 30_000).toISOString(), ...status() };
      return { granted: true, generation: 7, leaseUntil: new Date(NOW + 60_000).toISOString(), due: items.slice(0, limit ?? RECONCILER_BATCH_LIMIT), ...status() };
    },
    async record(_sweepId, generation, attempt) {
      calls.push(`record:${attempt.revocationId.slice(-2)}:${attempt.outcome}${attempt.outcome === 'failed' ? `:${attempt.failure}` : ''}`);
      expect(generation).toBe(7);
      const result = options.record ? await options.record(attempt, ++records) : 'recorded';
      if (result === 'recorded' || result === 'duplicate') recorded.push(attempt);
      return result;
    },
    async complete(_sweepId, generation) { calls.push('complete'); expect(generation).toBe(7); return { completed: true, ...status() }; },
  };
  return { store, calls, recorded };
}
/** A fictional signal writer: each publish answers from `outcomes` in turn (the last repeats); hold always works. */
function fakeSignal(outcomes: Array<'ok' | ProviderFailure>, hold: 'ok' | ProviderFailure = 'ok') {
  const calls: string[] = [];
  let n = 0;
  const answer = (o: 'ok' | ProviderFailure) => { if (o !== 'ok') throw new WorkforceProviderFailure(o); };
  return { calls, signal: {
    publish: vi.fn(async (subject: string, revocationId: string) => { calls.push(`publish:${subject}:${revocationId.slice(-2)}`); answer(outcomes[Math.min(n++, outcomes.length - 1)]!); }),
    hold: vi.fn(async (subject: string, decisionId: string) => { calls.push(`hold:${subject}:${decisionId.slice(-2)}`); answer(hold); }),
    release: vi.fn(async () => { throw new Error('the reconciler never releases'); }),
  } };
}
const run = (store: RevocationSignalReconcilerStore, signal: ReturnType<typeof fakeSignal>['signal'], extra: Partial<Parameters<typeof runRevocationSignalReconciler>[0]> = {}) => {
  const pauses: number[] = [];
  const result = runRevocationSignalReconciler({ store, signal, release: 'qualification', now: () => NOW, pause: async ms => { pauses.push(ms); }, ...extra }) as Promise<ReconcilerSummary>;
  return Object.assign(result, { pauses });
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the reconciler is BLOCKED', () => {
  it('in source; a run without the release reads nothing and writes nothing', async () => {
    expect(WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE).toBe('blocked');
    const { store, calls } = fakeStore([due(1)]);
    const { signal, calls: writes } = fakeSignal(['ok']);
    expect(await runRevocationSignalReconciler({ store, signal })).toEqual({ released: false });
    expect([calls, writes]).toEqual([[], []]);
  });

  it('the Lambda answers released: false and builds nothing, even with its environment lock open', async () => {
    vi.stubEnv('WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE', 'qualification');
    vi.stubEnv('WORKFORCE_REVOCATION_SIGNAL_TABLE', 'alp-campaign-staff-revocations');
    const dynamo = vi.spyOn(DynamoDBClient.prototype, 'send');
    expect(await handler()).toEqual({ released: false });
    expect(dynamo).not.toHaveBeenCalled();
  });

  it('building refuses a malformed table, and has no database adapter of its own: it never falls back to a broader credential', async () => {
    await expect(build({ WORKFORCE_REVOCATION_SIGNAL_TABLE: 'bad table!' })).rejects.toThrow('revocation_signal_reconciler_configuration_incomplete');
    await expect(build({ WORKFORCE_REVOCATION_SIGNAL_TABLE: 'alp-campaign-staff-revocations' })).rejects.toThrow('revocation_signal_reconciler_database_adapter_missing');
    const database = { transaction: vi.fn() } as unknown as ClinicalCoreDatabase;
    const send = vi.fn();
    const sweep = await build({ WORKFORCE_REVOCATION_SIGNAL_TABLE: 'alp-campaign-staff-revocations' }, { database, dynamo: { send } as never });
    // Built, it is still closed by the source release.
    expect(await sweep()).toEqual({ released: false });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('one sweep', () => {
  it('publishes each due revocation by the subject and id its record holds, records each outcome under the lease, then completes', async () => {
    const { store, calls } = fakeStore([due(1), due(2)]);
    const { signal, calls: writes } = fakeSignal(['ok']);
    const summary = await run(store, signal);
    expect(writes).toEqual(['publish:fictional-workforce-subject-0001:01', 'publish:fictional-workforce-subject-0002:02']);
    expect(calls).toEqual([`claim:${RECONCILER_BATCH_LIMIT}`, 'record:01:succeeded', 'record:02:succeeded', 'complete']);
    expect(summary).toMatchObject({ released: true, sweep: 'completed', examined: 2, published: 2, failed: 0, renewed: 0, unrecorded: 0, refused: 0,
      more: false, stoppedForOutage: false, unpublished: 0, overdue: false, alarms: [] });
  });

  it('bounded retries: a failing publish is tried twice with one pause, then the pending item is renewed and the failure recorded', async () => {
    const { store, calls } = fakeStore([due(1, { attempts: 2 })]);
    const { signal, calls: writes } = fakeSignal(['throttled']);
    const sweep = run(store, signal);
    const summary = await sweep;
    expect(RECONCILER_ATTEMPTS_PER_ITEM).toBe(2);
    expect(writes).toEqual(['publish:fictional-workforce-subject-0001:01', 'publish:fictional-workforce-subject-0001:01', 'hold:fictional-workforce-subject-0001:01']);
    expect(sweep.pauses).toEqual([RECONCILER_RETRY_PAUSE_MS]);
    expect(calls).toContain('record:01:failed:throttled');
    expect(summary).toMatchObject({ examined: 1, published: 0, failed: 1, renewed: 1, unpublished: 1, failures: [{ revocationId: due(1).revocationId, failure: 'throttled', attempts: 3 }] });
  });

  it('a lost reply inside the sweep: the second try finds the item there, and the outcome is succeeded with nothing renewed', async () => {
    const { store, calls } = fakeStore([due(1)]);
    const { signal, calls: writes } = fakeSignal(['timeout', 'ok']);
    expect(await run(store, signal)).toMatchObject({ published: 1, failed: 0, renewed: 0 });
    expect(writes).toHaveLength(2);
    expect(calls).toContain('record:01:succeeded');
  });

  it('a table outage stops the sweep after five consecutive items rather than hammering it, and says so', async () => {
    const items = Array.from({ length: 8 }, (_, i) => due(i + 1));
    const { store, calls } = fakeStore(items);
    const { signal } = fakeSignal(['unavailable'], 'unavailable');
    const summary = await run(store, signal);
    expect(RECONCILER_OUTAGE_STOP_AFTER).toBe(5);
    expect(signal.publish).toHaveBeenCalledTimes(5 * RECONCILER_ATTEMPTS_PER_ITEM);
    expect(calls.filter(c => c.startsWith('record:'))).toHaveLength(5);
    expect(summary).toMatchObject({ examined: 5, failed: 5, renewed: 0, stoppedForOutage: true, more: true, alarms: ['outage'] });
  });

  it('an item-specific failure never counts towards the outage, and a success resets it', async () => {
    const items = Array.from({ length: 7 }, (_, i) => due(i + 1));
    const { store } = fakeStore(items);
    const { signal } = fakeSignal(['unknown']);
    expect(await run(store, signal)).toMatchObject({ examined: 7, failed: 7, stoppedForOutage: false });
  });

  it('a sweep that runs past its budget stops and says more are due', async () => {
    let clock = NOW;
    const { store } = fakeStore([due(1), due(2), due(3)]);
    const { signal } = fakeSignal(['ok']);
    signal.publish.mockImplementation(async () => { clock += RECONCILER_SWEEP_BUDGET_MS + 1; });
    expect(await run(store, signal, { now: () => clock })).toMatchObject({ examined: 1, published: 1, more: true });
  });

  it('the record is retried under the same action id after a lost reply; an outcome it cannot record is reported, never assumed', async () => {
    const ids: string[] = [];
    const lostOnce = fakeStore([due(1)], { record: async (attempt, call) => { ids.push(attempt.actionId); if (call === 1) throw new Error('fictional lost reply'); return 'duplicate'; } });
    expect(await run(lostOnce.store, fakeSignal(['ok']).signal)).toMatchObject({ published: 1, unrecorded: 0, alarms: [] });
    expect(new Set(ids).size).toBe(1);
    const never = fakeStore([due(1)], { record: async () => { throw new Error('fictional database down'); } });
    expect(await run(never.store, fakeSignal(['ok']).signal)).toMatchObject({ published: 0, unrecorded: 1, alarms: ['unrecorded'], failures: [{ failure: 'unrecorded' }] });
  });

  it('a lost lease stops the sweep at once: nothing more is published, and it does not complete', async () => {
    const { store, calls } = fakeStore([due(1), due(2)], { record: async () => 'lease_lost' });
    const { signal } = fakeSignal(['ok']);
    expect(await run(store, signal)).toMatchObject({ sweep: 'lease_lost', examined: 1, alarms: ['lease_lost'] });
    expect(signal.publish).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('complete');
  });

  it('a lease held by another sweep: nothing is published, and the claim\'s own reading still reports overdue', async () => {
    const { store, calls } = fakeStore([due(1, { revokedAt: new Date(NOW - RECONCILER_OVERDUE_AFTER_MS - 1).toISOString() })], { held: true });
    const { signal } = fakeSignal(['ok']);
    expect(await run(store, signal)).toMatchObject({ sweep: 'held_elsewhere', examined: 0, published: 0, overdue: true, alarms: ['overdue'] });
    expect(signal.publish).not.toHaveBeenCalled();
    expect(calls).toEqual([`claim:${RECONCILER_BATCH_LIMIT}`]);
  });

  it('a malformed subject or id from the store is never published or recorded, and the sweep alarms', async () => {
    const { store, calls } = fakeStore([due(1, { subject: 'bad subject!' }), due(2, { revocationId: 'not-a-uuid' }), due(3)]);
    const { signal, calls: writes } = fakeSignal(['ok']);
    expect(await run(store, signal)).toMatchObject({ examined: 3, published: 1, refused: 2, alarms: ['refused'] });
    expect(writes).toEqual(['publish:fictional-workforce-subject-0003:03']);
    expect(calls.filter(c => c.startsWith('record:'))).toEqual(['record:03:succeeded']);
  });

  it('the database refusing a record (another subject, an unknown revocation) is a refusal alarm, and the sweep goes on', async () => {
    const { store } = fakeStore([due(1), due(2)], { record: async attempt => attempt.revocationId.endsWith('01') ? 'subject_mismatch' : 'recorded' });
    expect(await run(store, fakeSignal(['ok']).signal)).toMatchObject({ examined: 2, published: 1, refused: 1, alarms: ['refused'] });
  });

  it('overdue is the oldest revocation still unpublished after the sweep, by the injected clock', async () => {
    const old = due(1, { revokedAt: new Date(NOW - 6 * 60_000).toISOString() });
    const { store } = fakeStore([old]);
    const summary = await run(store, fakeSignal(['unavailable']).signal);
    expect(RECONCILER_OVERDUE_AFTER_MS).toBe(5 * 60_000);
    expect(summary).toMatchObject({ unpublished: 1, overdue: true, oldestUnpublishedAgeMs: 6 * 60_000, alarms: ['overdue'] });
    const recovered = await run(fakeStore([old]).store, fakeSignal(['ok']).signal);
    expect(recovered).toMatchObject({ unpublished: 0, overdue: false, oldestUnpublishedAgeMs: null, alarms: [] });
  });

  it('it can never release: it is handed no release, and the real writer over the fictional table deletes nothing', async () => {
    const table = fictionalSignalTable();
    const writer = createDynamoStaffRevocationSignalPublisher({ client: table.client as never, tableName: table.tableName, now: () => NOW });
    const release = vi.fn();
    const items = [due(1), due(2)];
    table.items.set(items[0]!.subject, { subject: items[0]!.subject, revocationId: randomUUID(), contract: 'staff-revocation-signal/1' });
    table.down.writes = true;
    await run(fakeStore(items).store, { ...writer, release } as never);
    table.down.writes = false;
    await run(fakeStore(items).store, { ...writer, release } as never);
    expect(release).not.toHaveBeenCalled();
    expect(table.writes.some(w => w.startsWith('delete:'))).toBe(false);
    // An item already there is a revocation: never replaced.
    expect(table.items.get(items[0]!.subject)).toMatchObject({ contract: 'staff-revocation-signal/1' });
    expect(table.items.get(items[1]!.subject)).toMatchObject({ revocationId: items[1]!.revocationId });
  });

  it('the summary names revocations by id, never by subject', async () => {
    const { store } = fakeStore([due(1), due(2)]);
    const summary = await run(store, fakeSignal(['unavailable']).signal);
    expect(JSON.stringify(summary)).not.toMatch(/fictional-workforce-subject/);
    expect(JSON.stringify(summary)).toContain(due(1).revocationId);
  });
});

describe('the reconciler\'s SQL store', () => {
  function database(replies: Record<string, unknown>, role = REVOCATION_SIGNAL_RECONCILER_ROLE) {
    const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const db: ClinicalCoreDatabase = { transaction: async work => work({ query: async (sql: string, parameters: readonly unknown[] = []) => {
      queries.push({ sql, parameters });
      if (sql.startsWith('set local role')) return { rows: [] } as never;
      if (sql.startsWith('select current_user')) return { rows: [{ role }] } as never;
      const name = /clinical_revocation_signal\.(\w+)\(/.exec(sql)?.[1] ?? '';
      return { rows: [{ r: JSON.stringify(replies[name]) }] } as never;
    } }) };
    return { db, queries };
  }
  const status = { unpublished: 1, oldestUnpublishedAt: '2026-10-17T11:59:00.000Z', lastCompletedAt: null };

  it('sets its own role, checks it, and calls exactly the reconciler\'s three functions with typed parameters', async () => {
    const sweepId = randomUUID(), actionId = randomUUID();
    const item = due(1);
    const { db, queries } = database({
      claim_sweep: { granted: true, generation: 3, leaseUntil: '2026-10-17T12:01:00.000Z', due: [item], ...status },
      record_attempt: { result: 'recorded', duplicate: false },
      complete_sweep: { completed: true, ...status },
    });
    const store = createSqlRevocationSignalReconcilerStore(db);
    expect(await store.claim(sweepId, 10)).toEqual({ granted: true, generation: 3, leaseUntil: '2026-10-17T12:01:00.000Z', due: [item], ...status });
    expect(await store.record(sweepId, 3, { actionId, revocationId: item.revocationId, subject: item.subject, outcome: 'failed', failure: 'throttled' })).toBe('recorded');
    expect(await store.complete(sweepId, 3)).toEqual({ completed: true, ...status });
    const calls = queries.filter(q => q.sql.includes('clinical_revocation_signal.'));
    expect(calls).toEqual([
      { sql: 'select clinical_revocation_signal.claim_sweep($1::uuid,$2::integer) as r', parameters: [sweepId, 10] },
      { sql: 'select clinical_revocation_signal.record_attempt($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5::text,$6::text,$7::text) as r',
        parameters: [sweepId, 3, actionId, item.revocationId, item.subject, 'failed', 'throttled'] },
      { sql: 'select clinical_revocation_signal.complete_sweep($1::uuid,$2::bigint) as r', parameters: [sweepId, 3] },
    ]);
    // Every transaction begins by taking the reconciler's role and checking it.
    expect(queries.filter(q => q.sql === `set local role ${REVOCATION_SIGNAL_RECONCILER_ROLE}`)).toHaveLength(3);
    expect(queries.filter(q => q.sql.startsWith('select current_user'))).toHaveLength(3);
  });

  it('refuses to run on a connection that is not the reconciler\'s role, before calling anything', async () => {
    const { db, queries } = database({}, 'postgres');
    await expect(createSqlRevocationSignalReconcilerStore(db).claim(randomUUID())).rejects.toThrow('revocation_signal_reconciler_role_required');
    expect(queries.some(q => q.sql.includes('clinical_revocation_signal.'))).toBe(false);
  });

  it('a reply that does not parse is a failure, never a grant; a limit outside 1 to 200 is refused before the database', async () => {
    const { db } = database({ claim_sweep: { granted: true, generation: 3, leaseUntil: 'x', due: [{ revocationId: 'x' }], ...status },
      record_attempt: { result: 'maybe' } });
    const store = createSqlRevocationSignalReconcilerStore(db);
    await expect(store.claim(randomUUID())).rejects.toThrow('revocation_signal_reconciler_reply_invalid');
    await expect(store.record(randomUUID(), 3, { actionId: randomUUID(), revocationId: randomUUID(), subject: due(1).subject, outcome: 'succeeded' })).rejects.toThrow('revocation_signal_reconciler_reply_invalid');
    await expect(store.claim(randomUUID(), 0)).rejects.toThrow('revocation_signal_reconciler_request_invalid');
    await expect(store.claim(randomUUID(), 201)).rejects.toThrow('revocation_signal_reconciler_request_invalid');
  });
});

describe('the reconciler\'s deployment specification', () => {
  type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
  const template = JSON.parse(readFileSync('infra/aws-clinical-core/workforce-revocation-signal-reconciler.json', 'utf8')) as {
    Metadata: { ClinicalCore: Record<string, unknown> };
    Parameters: Record<string, { Default?: string; AllowedValues?: string[]; AllowedPattern?: string }>; Conditions: Record<string, unknown>;
    Resources: Record<string, { Type: string; Condition?: string; Properties: Record<string, unknown> }> };
  const actions = (statement: Statement) => ([] as string[]).concat(statement.Action);

  it('deploys nothing: its release accepts only BLOCKED, every resource is conditioned on a value it cannot take, and its schedule only DISABLED', () => {
    expect(template.Parameters.ReconcilerRelease).toMatchObject({ Default: 'BLOCKED', AllowedValues: ['BLOCKED'] });
    expect(template.Conditions.ReconcilerReleased).toEqual({ 'Fn::Equals': [{ Ref: 'ReconcilerRelease' }, 'RELEASED'] });
    expect(Object.keys(template.Resources).length).toBeGreaterThan(0);
    for (const [name, resource] of Object.entries(template.Resources)) expect([name, resource.Condition]).toEqual([name, 'ReconcilerReleased']);
    expect(template.Parameters.ScheduleState).toMatchObject({ Default: 'DISABLED', AllowedValues: ['DISABLED'] });
    expect(template.Resources.ReconcilerSchedule!.Properties).toMatchObject({ ScheduleExpression: RECONCILER_SCHEDULE_EXPRESSION, State: { Ref: 'ScheduleState' } });
    expect(RECONCILER_SCHEDULE_EXPRESSION).toBe('rate(1 minute)');
    const fn = template.Resources.ReconcilerFunction!.Properties;
    expect(fn).toMatchObject({ ReservedConcurrentExecutions: 1, Timeout: 45 });
    expect((fn.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE: 'blocked', PHI_ALLOWED: 'false' });
    expect(template.Parameters.StaffRevocationSignalTableName!.AllowedPattern).toBe('^alp-campaign-staff-revocations$');
  });

  it('its own role holds exactly the minimum: PutItem on the signal table (no delete, no read), its own database secret, the Data API on one cluster', () => {
    const role = template.Resources.ReconcilerRole!.Properties as { Policies: Array<{ PolicyDocument: { Statement: Statement[] } }> };
    const statements = role.Policies.flatMap(policy => policy.PolicyDocument.Statement);
    expect(statements.every(statement => statement.Effect === 'Allow')).toBe(true);
    expect(statements.flatMap(actions).sort()).toEqual(['dynamodb:PutItem', 'kms:Decrypt', 'logs:CreateLogStream', 'logs:PutLogEvents',
      'rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:ExecuteStatement', 'rds-data:RollbackTransaction', 'secretsmanager:GetSecretValue']);
    const put = statements.find(statement => actions(statement).includes('dynamodb:PutItem'))!;
    expect(actions(put)).toEqual(['dynamodb:PutItem']);
    expect(JSON.stringify(put.Resource)).toMatch(/table\/\$\{StaffRevocationSignalTableName\}"}$/);
    expect(JSON.stringify(statements.find(statement => actions(statement).includes('secretsmanager:GetSecretValue'))!.Resource)).toBe('{"Ref":"ReconcilerDatabaseSecretArn"}');
    expect(JSON.stringify(statements.find(statement => actions(statement).includes('rds-data:ExecuteStatement'))!.Resource)).toBe('{"Ref":"ClinicalClusterArn"}');
    expect(JSON.stringify(statements)).not.toMatch(/"\*"|DeleteItem|UpdateItem|GetItem|Query|Scan|Batch|PartiQL|cognito|ses:|sns:Publish/i);
  });

  it('it alarms on its own: a failed or alarming sweep, and a reconciler that stopped running (no invocation reads as breaching)', () => {
    const errors = template.Resources.ReconcilerErrorAlarm!.Properties;
    expect(errors).toMatchObject({ MetricName: 'Errors', Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', AlarmActions: [{ Ref: 'AlarmTopicArn' }] });
    const silence = template.Resources.ReconcilerSilenceAlarm!.Properties;
    expect(silence).toMatchObject({ MetricName: 'Invocations', ComparisonOperator: 'LessThanThreshold', Threshold: 1, TreatMissingData: 'breaching', AlarmActions: [{ Ref: 'AlarmTopicArn' }] });
  });
});
