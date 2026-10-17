if (typeof window !== "undefined") throw new Error("The Fullscript revocation reconciler is server-only.");

import {
  reconcileFullscriptRevocation, type FullscriptRevocationFailure, type FullscriptRevocationOutbox, type FullscriptRevocationOutcome,
} from "./membership-generation";

/**
 * The revocation outbox's worker (BLOCKED). Every token this Desktop stopped using is queued in the outbox: a
 * connection superseded by a membership change, a token issued but refused at install, an install whose reply was
 * lost. Until something asks Fullscript to revoke them, they stay valid there. This is that something: a scheduled
 * pass over the outbox's queue index, across every clinic, at most `limit` items a run.
 *
 *   - **Confirmed before settled.** An item is settled only after Fullscript confirms the revocation; then its token
 *     is removed and, in the same transaction, the practitioner's reservation is released if it still names exactly
 *     that connection. A token a saved connection holds (a lost install reply that did commit) is never revoked.
 *   - **Retry with backoff.** A failure counts the attempt, keeps the token, and sets the next attempt 5 minutes later,
 *     doubling, at most a day apart (`revocationBackoffMs`). Nothing is ever dropped.
 *   - **Failure reporting.** The run answers counts and, per failure, a key fingerprint, its outcome and attempts:
 *     never a token, clinic, account key or provider id. An item that has failed `RECONCILER_STUCK_ATTEMPTS` times is
 *     `stuck`, and a run with any stuck item fails (the Lambda's error alarm), after logging the summary.
 *
 * Released together with its own least-privilege role and schedule (infra/aws-clinical-core/
 * fullscript-revocation-reconciler.json), whose release parameter accepts only BLOCKED, and the token table's queue
 * index (fullscript-connector-extension.json, `RevocationQueueIndex`, default disabled).
 */
export const FULLSCRIPT_REVOCATION_RECONCILER_RELEASE: "blocked" | "qualification" = "blocked";
export const RECONCILER_STUCK_ATTEMPTS = 8;
const MAX_REPORTED_FAILURES = 50;

export type FullscriptReconcilerSummary = {
  released: true; examined: number; revoked: number; inUse: number; failed: number; stuck: number; more: boolean;
  failures: Array<{ keyFingerprint: string; outcome: FullscriptRevocationFailure | "unrecorded"; attempts: number }>;
};

export async function runFullscriptRevocationReconciler(input: {
  outbox: FullscriptRevocationOutbox; environment: "sandbox_us" | "production_us"; revoke: (accessToken: string) => Promise<void>;
  limit?: number; now?: () => Date; release?: "blocked" | "qualification";
}): Promise<FullscriptReconcilerSummary | { released: false }> {
  if ((input.release ?? FULLSCRIPT_REVOCATION_RECONCILER_RELEASE) !== "qualification") return { released: false };
  const { items, more } = await input.outbox.due(input.limit ?? 50, input.now?.() ?? new Date());
  const summary: FullscriptReconcilerSummary = { released: true, examined: items.length, revoked: 0, inUse: 0, failed: 0, stuck: 0, more, failures: [] };
  for (const pending of items) {
    let outcome: FullscriptRevocationOutcome | "unrecorded";
    // A settle that fails leaves the item pending, its attempt uncounted: the next run asks Fullscript again.
    try { outcome = await reconcileFullscriptRevocation({ outbox: input.outbox, pending, environment: input.environment, revoke: input.revoke }); }
    catch { outcome = "unrecorded"; }
    if (outcome === "revoked") { summary.revoked++; continue; }
    if (outcome === "in_use") { summary.inUse++; continue; }
    const attempts = pending.item.attempts + (outcome === "unrecorded" ? 0 : 1);
    summary.failed++;
    if (attempts >= RECONCILER_STUCK_ATTEMPTS) summary.stuck++;
    if (summary.failures.length < MAX_REPORTED_FAILURES) summary.failures.push({ keyFingerprint: pending.item.keyFingerprint, outcome, attempts });
  }
  return summary;
}
