/**
 * Reusable clinical mutation runner (client-safe).
 *
 * One pattern for every review-style write, so behavior is consistent across
 * screens:
 *   1. apply an optimistic UI effect (in-memory only — see `review-state.ts`),
 *   2. call the backend, which persists the row AND writes the audit event
 *      atomically on the server,
 *   3. on failure, roll the optimistic effect back,
 *   4. return a standardized outcome with a clinician-safe message and whether
 *      it was actually persisted — the caller turns that into a toast.
 *
 * There is no demo branch: this repository is the clinical product, and a
 * mutation either persists to the record or reports its failure honestly.
 *
 * Confirmation for destructive / patient-facing actions is handled at the call
 * site (ConfirmDialog) before invoking this; this runner assumes it may write.
 */
import { toAdapterError, type AdapterErrorCode } from "./errors";

export interface MutationOutcome {
  ok: boolean;
  message: string;
  /** True only when the write persisted to the clinical record. */
  persisted: boolean;
  code?: AdapterErrorCode;
}

export interface ClinicalMutationSpec<T> {
  /** Optimistic UI effect applied before the write (in-memory only). */
  optimistic?: () => void;
  /** Undo the optimistic effect if the write fails. */
  rollback?: () => void;
  /** The write. Throws AdapterError on failure. */
  live: () => Promise<T>;
  /** Toast when the write persists ("saved to record"). */
  liveMessage: string;
}

export async function runClinicalMutation<T>(spec: ClinicalMutationSpec<T>): Promise<MutationOutcome> {
  spec.optimistic?.();
  try {
    await spec.live();
    return { ok: true, message: spec.liveMessage, persisted: true };
  } catch (e) {
    spec.rollback?.();
    const err = toAdapterError(e);
    return { ok: false, message: err.safeMessage, persisted: false, code: err.code };
  }
}
