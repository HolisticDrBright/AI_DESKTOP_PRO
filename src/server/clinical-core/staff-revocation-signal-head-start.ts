if (typeof window !== 'undefined') throw new Error('staff-revocation-signal-head-start is server-only');
import type { ClinicalCoreDatabase } from './database';
import type { StaffRevocationSignalPublisher } from './workforce-identity-revocation';

/**
 * The bounded head start for the pending campaign signal: an OWNER DECISION that has not been taken.
 *
 * The emergency revocation starts the pending signal (`pending#<subject>`) and never waits for it before the clinical
 * decision's transaction (workforce-identity-revocation.ts). So when the pending write is slower than the clinical
 * transaction (race order B), an old campaign token is admitted from the commit until the write lands: milliseconds on
 * a healthy table, reproduced as OPEN in revocation-signal-timing.database.test.ts.
 *
 * This wrapper would close that case for every pending write acknowledged within N ms, by holding the start of the
 * operator's next transaction until the pending write in flight settles or N ms pass, whichever is first. Its cost is
 * the other half of the same sentence: when the signal table is slow or down, the clinical refusal of a compromised
 * login starts up to N ms later, every time. It never makes the clinical decision depend on DynamoDB's answer: a
 * failed or unanswered pending write ends the wait at N ms at the latest, and the decision goes ahead.
 *
 * It is not on. Nothing constructs it outside tests (a test scans for that), and it has no default duration: whoever
 * builds it names N explicitly, from 1 to 1000 ms. PENDING_HEAD_START_DECISION records the proposal for Brandon, in
 * docs/revocation-signal-reconciler-2026-10-17.md §6. Wiring it is one line in the operator host, after his decision.
 *
 * Scope, stated: it waits for any pending write this host has in flight, not only the one the next transaction
 * decides. Two operators deciding at once on one host can each wait up to N ms for the other's write. That is the
 * same bound, never more.
 */
export const PENDING_HEAD_START_DECISION: { readonly status: 'owner_decision_required'; readonly proposedMs: 250; readonly maxMs: 1000 } =
  Object.freeze({ status: 'owner_decision_required', proposedMs: 250, maxMs: 1000 });

export function withPendingHeadStart(input: {
  database: ClinicalCoreDatabase; signal: StaffRevocationSignalPublisher; headStartMs: number; sleep?: (ms: number) => Promise<void>;
}): { database: ClinicalCoreDatabase; signal: StaffRevocationSignalPublisher } {
  const ms = input.headStartMs;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > PENDING_HEAD_START_DECISION.maxMs) throw new Error('pending_head_start_invalid');
  const sleep = input.sleep ?? ((wait: number) => new Promise<void>(resolve => setTimeout(resolve, wait)));
  const inFlight = new Set<Promise<unknown>>();
  return {
    signal: {
      publish: (subject, revocationId) => input.signal.publish(subject, revocationId),
      release: (subject, decisionId) => input.signal.release(subject, decisionId),
      hold(subject, decisionId) {
        const write = input.signal.hold(subject, decisionId);
        const settled = write.then(() => undefined, () => undefined);
        inFlight.add(settled);
        void settled.then(() => inFlight.delete(settled));
        return write;
      },
    },
    database: {
      async transaction(work) {
        if (inFlight.size > 0) await Promise.race([Promise.all([...inFlight]), sleep(ms)]);
        return input.database.transaction(work);
      },
    },
  };
}
