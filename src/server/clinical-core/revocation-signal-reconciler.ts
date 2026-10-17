if (typeof window !== 'undefined') throw new Error('revocation-signal-reconciler is server-only');
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClinicalCoreDatabase } from './database';
import { WorkforceProviderFailure, type ProviderFailure, type StaffRevocationSignalPublisher } from './workforce-identity-revocation';

/**
 * The campaign-signal reconciler (BLOCKED): a scheduled, operator-free retry of the emergency revocation's campaign
 * staff revocation signal (staff-revocation-signal/2), for every revocation whose publication is not confirmed.
 *
 * Why. The clinical database refuses a revoked login at its commit; the campaign engine learns of it only from its own
 * signal table (src/campaigns/staff-revocation.ts). When the final publication fails (the table unwritable, throttled,
 * its reply lost), the operator service records the step failed and leaves it on the operator's work list. Until now
 * only an operator's reconciliation retried it, so an old campaign token stayed admitted, and a queued send its login
 * scheduled kept going out, until an operator came back.
 *
 * What one sweep does (`runRevocationSignalReconciler`):
 *   1. **Claims the durable lease** through the reconciler's own database role (clinical_revocation_signal_reconciler,
 *      workforce-revocation-signal-reconciler.sql): one sweep at a time, 60 seconds, fenced by a generation. No
 *      operator subject is used or needed. A sweep that finds the lease held does nothing.
 *   2. **Reads the due list from the existing revocation records**: every revocation whose latest campaign_signal
 *      attempt did not succeed, or that has none, never attempted first, then least recently attempted. Those records
 *      are the only source of truth, and the attempts are the cursor: nothing else is kept between sweeps.
 *   3. **Publishes each one, idempotently**: exactly the subject and revocation id the record holds, with the writer's
 *      `attribute_not_exists` put, so a retry, a lost reply or a duplicate sweep finds the item there and succeeds
 *      without changing it. At most RECONCILER_ATTEMPTS_PER_ITEM tries per item per sweep.
 *   4. **Renews the pending item when a publication fails.** The revocation took effect, so keeping the login pending
 *      at the campaign engine is the safe direction: an old token stays refused past the first pending deadline, for as
 *      long as the reconciler runs inside each pending window and the pending write lands. It never stands in for the
 *      publication: the revocation stays due, and is overdue.
 *   5. **Records each outcome** under the lease, by its own idempotency key, for the record's own subject only. A lost
 *      record reply is retried once under the same key; an outcome it cannot record is reported, never assumed.
 *   6. **Completes**, and reports. A sweep is bounded: at most RECONCILER_BATCH_LIMIT items, RECONCILER_SWEEP_BUDGET_MS
 *      of work, and it stops after RECONCILER_OUTAGE_STOP_AFTER consecutive items fail for the table rather than the
 *      item (the table is down: the next sweep tries again). The summary names revocations by id, never by subject.
 *
 * **Alarms.** `alarms` lists `refused` (a record the database refused, or a malformed item: a defect or tampering),
 * `lease_lost`, `unrecorded`, `outage` and `overdue` (the oldest unpublished revocation is older than
 * RECONCILER_OVERDUE_AFTER_MS after the sweep). The Lambda fails on any of them after logging, so its error alarm
 * pages; its silence alarm pages when it stops running. Neither depends on an operator returning.
 *
 * **It never releases.** It is given no release, its role holds no DeleteItem, and it never writes the revocation key
 * except with `attribute_not_exists`: a revoked login is never made clear by anything here.
 *
 * **What it cannot do.** It bounds the time a revocation stays unpublished by roughly one schedule period after the
 * writer recovers. It cannot make the interval between the clinical commit and the first publication zero: on a
 * pending write slower than the commit (race order B) or a writer down at the commit, the old token is admitted from
 * the commit until a publication lands. See docs/revocation-signal-reconciler-2026-10-17.md.
 *
 * Released together with its SQL candidate, its template (infra/aws-clinical-core/workforce-revocation-signal-
 * reconciler.json, whose release parameter accepts only BLOCKED) and a role-scoped Aurora adapter that does not exist
 * yet. One reviewed change, never separately.
 */
export const WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE: 'blocked' | 'qualification' = 'blocked';
export const WORKFORCE_REVOCATION_SIGNAL_RECONCILER_SHA256 = '5ef389b41ca3efc230364ef38e878dcd48055f5899bf4aba27e855af3c6a7946';
export const WORKFORCE_REVOCATION_SIGNAL_RECONCILER_ROLLBACK_SHA256 = 'bf272983de34c692eb0ed4fcfcc851f6ff5a5fb24642f05afdfdedf9f8c3c763';
/** prosrc SHA-256 of each function the candidate defines. */
export const WORKFORCE_REVOCATION_SIGNAL_RECONCILER_PROSRC = {
  status: '970fe12e450bb4c52ebfa9d4c3e0dbaefee845e7abd0fe7609f4c4c07742cb7d',
  claim: 'eb495344faa066add3e45114a820e03212575518bdacdf0e99b6f6282e98b276',
  record: '705ec0b0722bbab43ac4d9b17d2eb8f63d466e948941faabfb46e2ca0b852dd9',
  complete: 'c5494ed3275da42cbeb2c6503ea034e78a1d9d733ab2854311aa6df46b489857',
} as const;
export const REVOCATION_SIGNAL_RECONCILER_ROLE = 'clinical_revocation_signal_reconciler';
/** The proposed schedule (the template's, DISABLED). It is what bounds the outage window: see the doc. */
export const RECONCILER_SCHEDULE_EXPRESSION = 'rate(1 minute)';
export const RECONCILER_BATCH_LIMIT = 100;
export const RECONCILER_ATTEMPTS_PER_ITEM = 2;
export const RECONCILER_RETRY_PAUSE_MS = 250;
export const RECONCILER_OUTAGE_STOP_AFTER = 5;
export const RECONCILER_SWEEP_BUDGET_MS = 30_000;
export const RECONCILER_OVERDUE_AFTER_MS = 5 * 60_000;
/** The SQL lease's length (fixed in the candidate, never chosen by a caller). */
export const RECONCILER_LEASE_MS = 60_000;

const SUBJECT = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A failure that says the table (or its credential) is unavailable, rather than something about this one item. */
const OUTAGE: ReadonlySet<ProviderFailure> = new Set(['throttled', 'unavailable', 'timeout', 'access_denied', 'not_found']);

export type DueRevocation = { revocationId: string; subject: string; revokedAt: string; attempts: number; lastAttemptAt: string | null };
export type ReconcilerStatus = { unpublished: number; oldestUnpublishedAt: string | null; lastCompletedAt: string | null };
export type ReconcilerClaim = ({ granted: true; generation: number; leaseUntil: string; due: DueRevocation[] }
  | { granted: false; reason?: 'lease_held' | 'sweep_id_used'; leaseUntil: string | null }) & ReconcilerStatus;
export type ReconcilerAttempt = { actionId: string; revocationId: string; subject: string }
  & ({ outcome: 'succeeded' } | { outcome: 'failed'; failure: ProviderFailure });
export type ReconcilerRecordResult = 'recorded' | 'duplicate' | 'lease_lost' | 'not_found' | 'subject_mismatch';
export interface RevocationSignalReconcilerStore {
  claim(sweepId: string, limit?: number): Promise<ReconcilerClaim>;
  record(sweepId: string, generation: number, attempt: ReconcilerAttempt): Promise<ReconcilerRecordResult>;
  complete(sweepId: string, generation: number): Promise<{ completed: boolean } & ReconcilerStatus>;
}
export type ReconcilerAlarm = 'refused' | 'lease_lost' | 'unrecorded' | 'outage' | 'overdue';
export type ReconcilerSummary = {
  released: true; sweep: 'completed' | 'held_elsewhere' | 'lease_lost';
  examined: number; published: number; failed: number; renewed: number; unrecorded: number; refused: number;
  more: boolean; stoppedForOutage: boolean;
  unpublished: number; oldestUnpublishedAgeMs: number | null; overdue: boolean; lastCompletedAt: string | null;
  failures: Array<{ revocationId: string; failure: ProviderFailure | 'unrecorded' | 'refused'; attempts: number }>;
  alarms: ReconcilerAlarm[];
};
const MAX_REPORTED_FAILURES = 50;
const ALARM_ORDER: readonly ReconcilerAlarm[] = ['refused', 'lease_lost', 'unrecorded', 'outage', 'overdue'];

/* ------------------------------------------------------------------------------------------------- the SQL store */
const timestamp = z.string().min(1).refine(value => Number.isFinite(Date.parse(value)));
const status = { unpublished: z.number().int().min(0), oldestUnpublishedAt: timestamp.nullable(), lastCompletedAt: timestamp.nullable() };
const dueRevocation = z.object({ revocationId: z.string().regex(UUID), subject: z.string().min(1).max(256), revokedAt: timestamp,
  attempts: z.number().int().min(0), lastAttemptAt: timestamp.nullable() }).strict();
const claimReply = z.union([
  z.object({ granted: z.literal(true), generation: z.number().int().positive(), leaseUntil: timestamp, due: z.array(dueRevocation).max(200), ...status }).strict(),
  z.object({ granted: z.literal(false), reason: z.enum(['lease_held', 'sweep_id_used']), leaseUntil: timestamp.nullable(), ...status }).strict(),
]);
const recordReply = z.union([
  z.object({ result: z.literal('recorded'), duplicate: z.boolean() }).strict(),
  z.object({ result: z.enum(['lease_lost', 'not_found', 'subject_mismatch']) }).strict(),
]);
const completeReply = z.object({ completed: z.boolean(), ...status }).strict();
const parse = (value: unknown) => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
/** Database timestamps, normalised to ISO 8601 so the reply's shape never depends on the transport's rendering. */
const iso = (value: unknown) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : value);
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, /At$|Until$/.test(key) ? iso(v) : normalise(v)]));
}

/**
 * The reconciler's three SQL functions over its own connection. Every transaction first takes the reconciler's role and
 * checks that it holds it, so the store never runs with a broader credential's rights even if it is handed one.
 */
export function createSqlRevocationSignalReconcilerStore(database: ClinicalCoreDatabase): RevocationSignalReconcilerStore {
  const call = <T>(schema: z.ZodType<T>, sql: string, parameters: unknown[]) => database.transaction(async tx => {
    await tx.query(`set local role ${REVOCATION_SIGNAL_RECONCILER_ROLE}`);
    const { rows: [who] } = await tx.query<{ role: unknown }>('select current_user as role');
    if (who?.role !== REVOCATION_SIGNAL_RECONCILER_ROLE) throw new Error('revocation_signal_reconciler_role_required');
    const { rows } = await tx.query<{ r: unknown }>(sql, parameters);
    const reply = schema.safeParse(normalise(parse(rows[0]?.r)));
    if (!reply.success) throw new Error('revocation_signal_reconciler_reply_invalid');
    return reply.data;
  });
  return {
    async claim(sweepId, limit = RECONCILER_BATCH_LIMIT) {
      if (!UUID.test(sweepId) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('revocation_signal_reconciler_request_invalid');
      return call(claimReply, 'select clinical_revocation_signal.claim_sweep($1::uuid,$2::integer) as r', [sweepId, limit]) as Promise<ReconcilerClaim>;
    },
    async record(sweepId, generation, attempt) {
      const reply = await call(recordReply, 'select clinical_revocation_signal.record_attempt($1::uuid,$2::bigint,$3::uuid,$4::uuid,$5::text,$6::text,$7::text) as r',
        [sweepId, generation, attempt.actionId, attempt.revocationId, attempt.subject, attempt.outcome, attempt.outcome === 'failed' ? attempt.failure : null]);
      return reply.result === 'recorded' ? (reply.duplicate ? 'duplicate' : 'recorded') : reply.result;
    },
    async complete(sweepId, generation) {
      return call(completeReply, 'select clinical_revocation_signal.complete_sweep($1::uuid,$2::bigint) as r', [sweepId, generation]);
    },
  };
}

/* ------------------------------------------------------------------------------------------------------ one sweep */
export async function runRevocationSignalReconciler(input: {
  store: RevocationSignalReconcilerStore;
  /** The signal writer. The reconciler publishes and renews; it is never handed a release, and never calls one. */
  signal: Pick<StaffRevocationSignalPublisher, 'publish' | 'hold'>;
  release?: 'blocked' | 'qualification';
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  newId?: () => string;
  limit?: number;
}): Promise<ReconcilerSummary | { released: false }> {
  if ((input.release ?? WORKFORCE_REVOCATION_SIGNAL_RECONCILER_RELEASE) !== 'qualification') return { released: false };
  const now = input.now ?? Date.now;
  const pause = input.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const newId = input.newId ?? randomUUID;
  const sweepId = newId();
  // A database that cannot be reached throws here: the run fails, and the Lambda's error alarm is the report.
  const claim = await input.store.claim(sweepId, input.limit ?? RECONCILER_BATCH_LIMIT);
  const summary: ReconcilerSummary = { released: true, sweep: 'completed', examined: 0, published: 0, failed: 0, renewed: 0, unrecorded: 0, refused: 0,
    more: false, stoppedForOutage: false, unpublished: claim.unpublished, oldestUnpublishedAgeMs: null, overdue: false, lastCompletedAt: claim.lastCompletedAt,
    failures: [], alarms: [] };
  const alarms = new Set<ReconcilerAlarm>();
  const fail = (revocationId: string, failure: ReconcilerSummary['failures'][number]['failure'], attempts: number) => {
    if (summary.failures.length < MAX_REPORTED_FAILURES) summary.failures.push({ revocationId, failure, attempts });
  };
  const finish = (state: ReconcilerStatus) => {
    summary.unpublished = state.unpublished;
    summary.lastCompletedAt = state.lastCompletedAt;
    summary.oldestUnpublishedAgeMs = state.oldestUnpublishedAt ? Math.max(0, now() - Date.parse(state.oldestUnpublishedAt)) : null;
    summary.overdue = summary.oldestUnpublishedAgeMs !== null && summary.oldestUnpublishedAgeMs > RECONCILER_OVERDUE_AFTER_MS;
    if (summary.overdue) alarms.add('overdue');
    summary.alarms = ALARM_ORDER.filter(alarm => alarms.has(alarm));
    return summary;
  };
  if (!claim.granted) { summary.sweep = 'held_elsewhere'; return finish(claim); }

  const started = now();
  let outageStreak = 0;
  for (const [index, item] of claim.due.entries()) {
    if (now() - started > RECONCILER_SWEEP_BUDGET_MS || outageStreak >= RECONCILER_OUTAGE_STOP_AFTER) {
      summary.more = true;
      summary.stoppedForOutage = outageStreak >= RECONCILER_OUTAGE_STOP_AFTER;
      if (summary.stoppedForOutage) alarms.add('outage');
      break;
    }
    summary.examined++;
    // Defence in depth: the record's own check constraint already holds these. Anything else is never published.
    if (!SUBJECT.test(item.subject) || !UUID.test(item.revocationId)) {
      summary.refused++; alarms.add('refused'); fail(UUID.test(item.revocationId) ? item.revocationId : 'malformed', 'refused', item.attempts);
      continue;
    }
    let failure: ProviderFailure | undefined;
    for (let attempt = 1; attempt <= RECONCILER_ATTEMPTS_PER_ITEM; attempt++) {
      try { await input.signal.publish(item.subject, item.revocationId); failure = undefined; break; } catch (error) {
        failure = error instanceof WorkforceProviderFailure ? error.code : 'unknown';
        if (attempt < RECONCILER_ATTEMPTS_PER_ITEM) await pause(RECONCILER_RETRY_PAUSE_MS);
      }
    }
    if (failure) {
      // The revocation took effect: holding the login pending is the safe direction, and lapses by itself if this
      // reconciler stops. The revocation's own id names the hold, so no decision's release can remove it.
      try { await input.signal.hold(item.subject, item.revocationId); summary.renewed++; } catch { /* the item stays due either way */ }
      outageStreak = OUTAGE.has(failure) ? outageStreak + 1 : 0;
    } else outageStreak = 0;

    const attempt: ReconcilerAttempt = failure
      ? { actionId: newId(), revocationId: item.revocationId, subject: item.subject, outcome: 'failed', failure }
      : { actionId: newId(), revocationId: item.revocationId, subject: item.subject, outcome: 'succeeded' };
    let result: ReconcilerRecordResult | 'unrecorded' = 'unrecorded';
    // Once more under the same key: a reply lost after its commit is recognised as a duplicate, never written twice.
    for (let tries = 0; tries < 2 && result === 'unrecorded'; tries++) {
      try { result = await input.store.record(sweepId, claim.generation, attempt); } catch { result = 'unrecorded'; }
    }
    if (result === 'lease_lost') {
      // Another sweep holds the lease now: it records this item itself. Nothing more is published under a lost lease.
      summary.sweep = 'lease_lost'; alarms.add('lease_lost');
      summary.more = index < claim.due.length - 1;
      return finish(claim);
    }
    if (result === 'not_found' || result === 'subject_mismatch') {
      summary.refused++; alarms.add('refused'); fail(item.revocationId, 'refused', item.attempts);
      continue;
    }
    if (result === 'unrecorded') {
      summary.unrecorded++; alarms.add('unrecorded'); fail(item.revocationId, 'unrecorded', item.attempts);
      continue;
    }
    if (failure) { summary.failed++; fail(item.revocationId, failure, item.attempts + 1); } else summary.published++;
  }
  let state: ReconcilerStatus = claim;
  try {
    const completed = await input.store.complete(sweepId, claim.generation);
    if (!completed.completed) { summary.sweep = 'lease_lost'; alarms.add('lease_lost'); }
    state = completed;
  } catch { alarms.add('unrecorded'); }
  return finish(state);
}
