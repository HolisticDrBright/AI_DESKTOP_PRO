if (typeof window !== 'undefined') throw new Error('reviewed commerce bootstrap is server-only');
import { installLearnerHost } from '../../learner/learner-host';
import { createReviewedLearnerHost, setReviewedLearnerResolver, type ReviewedLearnerRuntime } from '../../learner/reviewed-learner-host';
import { installReviewedPurchasing, type ReviewedPurchasing } from '../program-commerce-runtime';
import { commerceFlagsOn, type CommerceHoldReason, type ProgramCommerceHostTarget } from './commerce-host-target';
import { readCommerceHostTargetFile } from './commerce-host-target-source';
import { createReviewedCommerceRuntime, type ReviewedCommerceInputs } from './reviewed-commerce-runtime';

/**
 * The deployment's reviewed bootstrap for the Desktop server, called once from instrumentation. It
 * is the ONLY caller of installLearnerHost and installReviewedPurchasing, and it does nothing unless
 *
 *   - this is the clinical edition with PROGRAM_COMMERCE_QUALIFICATION_ENABLED=true, PHI_ALLOWED=false
 *     and PRODUCTION_ACTIVATION=blocked, not readiness-only and not the local contract fixture; and
 *   - the mounted target reads and verifies (pinned digest, pinned source commit, schema) at boot
 *     and its activation evidence names every candidate.
 *
 * What it installs re-resolves on EVERY request: the flags are re-read and the target is re-read and
 * re-verified, and the composed runtime is reused only while the target's digest is the one it was
 * composed from. A target removed or replaced after boot closes the learner page, the sign-in, the
 * checkout and the webhook at the next request. Purchasing opens only where the readiness says so;
 * a held decision, a missing credential, price id or sealing key leaves it disabled while reading
 * stays open. The existing production gates (the AWS production runtime assertion, readiness-only
 * middleware, the pilot policy) are not consulted or changed here; this target cannot name a
 * production account, PHI or an unblocked activation.
 */
export type BootstrapOutcome =
  | { installed: true; learner: true; purchasing: boolean; holds: CommerceHoldReason[] }
  | { installed: false; reason: 'not_clinical' | 'flags_off' | 'target_unavailable' | 'runtime_closed'; holds?: CommerceHoldReason[] };

type BootstrapDeps = {
  env?: Record<string, string | undefined>;
  /** The target read; the mounted file by default. Source tests inject a reader over their own file. */
  readTarget?: (signal: AbortSignal) => Promise<ProgramCommerceHostTarget>;
  runtimeInputs?: Omit<ReviewedCommerceInputs, 'target' | 'env'>;
};

const READ_DEADLINE_MS = 5_000;

export async function bootstrapReviewedCommerce(deps: BootstrapDeps = {}): Promise<BootstrapOutcome> {
  const env = deps.env ?? process.env;
  if (env.APP_EDITION !== 'clinical') return { installed: false, reason: 'not_clinical' };
  if (!commerceFlagsOn(env)) return { installed: false, reason: 'flags_off' };
  const readTarget = deps.readTarget ?? ((signal: AbortSignal) => readCommerceHostTargetFile(env, signal));
  const read = async () => {
    const signal = AbortSignal.timeout(READ_DEADLINE_MS);
    return readTarget(signal);
  };
  let target: ProgramCommerceHostTarget;
  try { target = await read(); } catch { return { installed: false, reason: 'target_unavailable' }; }
  const composed = createReviewedCommerceRuntime({ ...deps.runtimeInputs, target, env });
  if (!composed.learner) return { installed: false, reason: 'runtime_closed', holds: composed.readiness.learner.holds };
  const pinned = JSON.stringify(target);

  /** This request's runtime, or null: flags re-read, target re-read and unchanged. */
  const current = async () => {
    if (env.APP_EDITION !== 'clinical' || !commerceFlagsOn(env)) return null;
    const now = await read().catch(() => null);
    return now && JSON.stringify(now) === pinned ? composed : null;
  };
  const learner = async (): Promise<ReviewedLearnerRuntime | null> => {
    const runtime = await current();
    return runtime?.learner ? { verify: runtime.learner.verify, services: runtime.learner.services, consumer: target.consumer } : null;
  };
  const purchasing = async (): Promise<ReviewedPurchasing | null> => {
    const runtime = await current();
    const open = runtime?.purchasing;
    return open ? { kind: 'reviewed', checkout: open.checkout, expected: open.expected, ledger: open.ledger, offers: open.offers } : null;
  };
  setReviewedLearnerResolver(learner);
  installLearnerHost(createReviewedLearnerHost(learner));
  installReviewedPurchasing(purchasing, env);
  return { installed: true, learner: true, purchasing: !!composed.purchasing, holds: composed.readiness.purchasing.holds };
}
