if (typeof window !== 'undefined') throw new Error('revocation-signal-reconciler-lambda is server-only');
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ClinicalCoreDatabase } from './database';
import {
  WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE, createSqlRevocationSignalReconcilerStore, runRevocationSignalReconciler, type ReconcilerSummary,
} from './revocation-signal-reconciler';
import { createDynamoStaffRevocationSignalPublisher } from './staff-revocation-signal';

/**
 * The scheduled campaign-signal reconciler Lambda (BLOCKED). Both locks must open before anything is built: the source
 * release constant, and WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE in its environment. Closed, it reads nothing,
 * holds no client and answers `{ released: false }`.
 *
 * Open, it runs one bounded sweep and logs the summary (counts and revocation ids, never a subject), and fails after
 * logging when the summary carries any alarm, so the function's error alarm is the page. Its Aurora connection must be
 * the reconciler's own role-scoped login (clinical_revocation_signal_reconciler). That adapter does not exist in
 * rds-data-database.ts yet, so `build` refuses without one: nothing here falls back to a broader credential.
 */
type Env = Record<string, string | undefined>;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
let ready: Promise<() => Promise<ReconcilerSummary | { released: false }>> | null = null;

export async function build(env: Env = process.env, deps: { database?: ClinicalCoreDatabase; dynamo?: Pick<DynamoDBDocumentClient, 'send'> } = {}) {
  const tableName = env.WORKFORCE_REVOCATION_SIGNAL_TABLE;
  if (!tableName || !TABLE.test(tableName)) throw new Error('revocation_signal_reconciler_configuration_incomplete');
  if (!deps.database) throw new Error('revocation_signal_reconciler_database_adapter_missing');
  const store = createSqlRevocationSignalReconcilerStore(deps.database);
  const client = deps.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.AWS_REGION }));
  const signal = createDynamoStaffRevocationSignalPublisher({ client, tableName, timeoutMs: 2000 });
  // The source release governs here too: building the worker never opens it.
  return () => runRevocationSignalReconciler({ store, signal });
}

export async function handler(): Promise<ReconcilerSummary | { released: false }> {
  if (WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE !== 'qualification' || process.env.WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE !== 'qualification') {
    return { released: false };
  }
  ready ??= build();
  const summary = await (await ready)();
  console.log(JSON.stringify({ event: 'workforce.revocation_signal.reconcile', ...summary }));
  if (summary.released && summary.alarms.length > 0) throw new Error(`revocation_signal_reconciler_alarm:${summary.alarms.join(',')}`);
  return summary;
}
