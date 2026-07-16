/**
 * Reusable clinical mutation runner (client-safe).
 *
 * One pattern for every review-style write, so behavior is consistent across
 * screens:
 *   1. apply an optimistic UI effect,
 *   2. in LIVE mode call the backend (persisting + writing a real audit row);
 *      in DEMO mode apply the session-store effect (audit stays in-session),
 *   3. on a live failure, roll the optimistic effect back,
 *   4. return a standardized outcome with a clinician-safe message and whether
 *      it was actually persisted — the caller turns that into a toast.
 *
 * Confirmation for destructive / patient-facing actions is handled at the call
 * site (ConfirmDialog) before invoking this; this runner assumes it may write.
 */
import { USE_LIVE_API } from "./mode";
import { toAdapterError, type AdapterErrorCode } from "./errors";

export interface MutationOutcome {
  ok: boolean;
  message: string;
  /** True only when a live write succeeded (false in demo, false on error). */
  persisted: boolean;
  code?: AdapterErrorCode;
}

export interface ClinicalMutationSpec<T> {
  /** Optimistic UI effect applied before the write (both modes). */
  optimistic?: () => void;
  /** Undo the optimistic effect if the live write fails. */
  rollback?: () => void;
  /** The live write. Runs only in live mode; throws AdapterError on failure. */
  live: () => Promise<T>;
  /** The demo effect (session-store write). Runs only in mock mode. */
  demo: () => void;
  /** Toast when the live write persists ("saved to record"). */
  liveMessage: string;
  /** Toast in demo mode ("not persisted"). */
  demoMessage: string;
}

export async function runClinicalMutation<T>(spec: ClinicalMutationSpec<T>): Promise<MutationOutcome> {
  spec.optimistic?.();

  if (!USE_LIVE_API) {
    spec.demo();
    return { ok: true, message: spec.demoMessage, persisted: false };
  }

  try {
    await spec.live();
    return { ok: true, message: spec.liveMessage, persisted: true };
  } catch (e) {
    spec.rollback?.();
    const err = toAdapterError(e);
    return { ok: false, message: err.safeMessage, persisted: false, code: err.code };
  }
}
