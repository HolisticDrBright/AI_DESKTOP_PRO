if (typeof window !== 'undefined') throw new Error('commerce host target is server-only');
import { z } from 'zod';
import { programCommerceActivation, PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 } from '../program-commerce-activation';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256 } from '../program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 } from '../program-education-ledger-sql';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from '../program-commerce-authority';
import { PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256 } from './commerce-role-sessions';
import { learnerMediaStorageConfig } from '../../programs/aws-learner-media-storage';
import { PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256 } from '../../programs/learner-media';

/**
 * The reviewed program-commerce host target (program-commerce-host-target/1): the ONE document that
 * can open the purchase-to-course runtime, and only for the synthetic qualification target. It is a
 * read-only container mount whose SHA-256 and source commit the deployment pins separately, in the
 * same posture as the program-media host. A well-shaped target does not establish that its reviews
 * happened or its resources exist; it names them, and every request re-reads and re-checks it.
 *
 *   - qualification only: the fixed qualification account, region and database, PHI off, production
 *     activation blocked. A production education family is a separate, unwritten review;
 *   - four database sessions, one per authority (API, worker, delivery, operator), each its own
 *     secret and its own runtime login. A shared secret or login is refused;
 *   - the consumer user pool and app client the learner's session must come from;
 *   - activation evidence naming every BLOCKED candidate this source was built against;
 *   - the test-mode processor account, API version and the price ids it holds. No price is chosen
 *     here: an empty list holds purchasing;
 *   - the delivery sender and the sealing key reference (the key itself is a secret, never here);
 *   - Brandon's decisions as records. A decision that is not recorded as decided is HELD, and a held
 *     decision that purchasing needs keeps purchasing disabled. Nothing defaults;
 *   - optionally, learner lesson media (program-learner-media/1): the BLOCKED admission candidate's
 *     identity, the dedicated educational bucket, its key, the reviewed read-only learner role and
 *     the review receipt. Absent, every media read answers `held` and nothing is read.
 */
export const PROGRAM_COMMERCE_HOST_TARGET = 'program-commerce-host-target/1' as const;
const QUALIFICATION_ACCOUNT = '588966314750';
const REGION = 'us-east-2';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const secretArn = z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]{1,180}$/);
const session = <L extends string>(login: L) => z.object({ secretArn, login: z.literal(login) }).strict();
const httpsOrigin = z.string().url().refine(value => { try { const url = new URL(value); return value === url.origin && url.protocol === 'https:' && !url.username && !url.password && !url.port; } catch { return false; } });
const decidedBy = z.string().trim().min(1).max(200);
const held = z.object({ state: z.literal('held') }).strict();
const decided = <T extends z.ZodTypeAny>(value: T) => z.object({ state: z.literal('decided'), value, decidedBy, decidedAt: z.string().datetime({ offset: true }), evidenceSha256: digest }).strict();

/** The candidate identities the reviewed runtime is built against, in parent order. */
export const REVIEWED_COMMERCE_CANDIDATES = Object.freeze({
  offer: PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256,
  checkout: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256,
  checkoutRecovery: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256,
  education: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256,
  educationDelivery: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256,
  commerceAuthority: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256,
  educationProgress: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256,
  runtimeSessions: PROGRAM_COMMERCE_RUNTIME_SESSIONS_SCHEMA_CANDIDATE_SHA256,
});

export const programCommerceHostTarget = z.object({
  contract: z.literal(PROGRAM_COMMERCE_HOST_TARGET),
  execution: z.literal('qualification'),
  account: z.literal(QUALIFICATION_ACCOUNT), region: z.literal(REGION),
  phiAllowed: z.literal(false), productionActivation: z.literal('blocked'),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), hostReviewSha256: digest,
  database: z.object({
    clusterArn: z.string().regex(/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/),
    databaseName: z.literal('clinical_core_qualification'),
    sessions: z.object({
      api: session('program_commerce_api_runtime'),
      worker: session('program_commerce_worker_runtime'),
      delivery: session('program_commerce_delivery_runtime'),
      operator: session('program_commerce_operator_runtime'),
    }).strict(),
  }).strict(),
  consumer: z.object({
    poolId: z.string().regex(/^us-east-2_[A-Za-z0-9]{1,55}$/),
    clientId: z.string().regex(/^[a-z0-9]{1,128}$/),
    /** The pool's hosted sign-in domain, for the Desktop learner page's authorization-code sign-in. */
    signInOrigin: httpsOrigin.refine(value => /^https:\/\/[a-z0-9-]{1,63}\.auth\.us-east-2\.amazoncognito\.com$/.test(value)),
    /** The Desktop origin learners sign in to; its callback is fixed at /api/my-courses/session/callback. */
    desktopOrigin: httpsOrigin,
  }).strict(),
  activation: programCommerceActivation,
  candidates: z.object({
    offer: digest, checkout: digest, checkoutRecovery: digest, education: digest, educationDelivery: digest,
    commerceAuthority: digest, educationProgress: digest, runtimeSessions: digest,
  }).strict(),
  processor: z.object({
    mode: z.literal('test'),
    accountRef: z.string().regex(/^acct_[A-Za-z0-9]{8,64}$/),
    apiVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/),
    /** The processor-held price ids an offer may name. Empty holds purchasing; nothing is created or priced here. */
    priceRefs: z.array(z.string().regex(/^price_[A-Za-z0-9]{6,64}$/)).max(50),
  }).strict(),
  delivery: z.object({
    provider: z.literal('ses'), region: z.literal(REGION),
    fromAddress: z.string().regex(/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/),
    configurationSet: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    messageIdDomain: z.string().regex(/^[a-z0-9.-]{1,180}\.[a-z]{2,24}$/),
  }).strict(),
  /** The sealing key's reference; the 32-byte key is a secret the host injects, never part of the target. */
  sealing: z.object({ keyRef: z.string().regex(/^claim-sealer:[a-z0-9-]{1,64}\/v[1-9][0-9]{0,3}$/) }).strict(),
  decisions: z.object({
    /** Whether the contact the payment processor collected may receive the one-time code. */
    purchaserContactAuthority: z.union([held, decided(z.literal('payment_processor_collected_email'))]),
    /** How long a one-time code stays valid, in days. */
    claimCodeLifetimeDays: z.union([held, decided(z.number().int().min(1).max(30))]),
    /** Whether staff may see a learner's lesson progress. No staff progress surface exists while held. */
    staffProgressVisibility: z.union([held, decided(z.enum(['none', 'completion_counts']))]),
    /** How the storefronts classify a course purchase. V2 offers no purchase while held. */
    storefrontClassification: z.union([held, decided(z.string().min(1).max(120))]),
  }).strict(),
  learnerMedia: z.object({
    candidate: digest,
    storage: learnerMediaStorageConfig,
    /** The learner-delivery review receipt; the database's own delivery row must also be enabled by a reviewed change. */
    evidenceSha256: digest,
  }).strict().optional(),
}).strict().superRefine((target, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const sessions = Object.values(target.database.sessions);
  if (new Set(sessions.map(s => s.secretArn)).size !== sessions.length) fail('commerce_sessions_share_a_secret');
  if (new Set(sessions.map(s => s.login)).size !== sessions.length) fail('commerce_sessions_share_a_login');
  for (const [name, pinned] of Object.entries(REVIEWED_COMMERCE_CANDIDATES)) {
    if (target.candidates[name as keyof typeof target.candidates] !== pinned) fail(`candidate_mismatch:${name}`);
  }
  if (new Set(target.processor.priceRefs).size !== target.processor.priceRefs.length) fail('duplicate_price_ref');
  if (target.learnerMedia && target.learnerMedia.candidate !== PROGRAM_MEDIA_LEARNER_ADMISSION_SCHEMA_CANDIDATE_SHA256) fail('candidate_mismatch:learnerMedia');
  const desktop = new URL(target.consumer.desktopOrigin).hostname;
  if (desktop === 'localhost' || /^[0-9.]+$/.test(desktop)) fail('desktop_origin_refused');
});
export type ProgramCommerceHostTarget = z.infer<typeof programCommerceHostTarget>;

/* ------------------------------------------------------------------ readiness */

export type CommerceCapability = 'learner' | 'purchasing' | 'worker';
export type CommerceHoldReason =
  | 'flags_off' | 'target_unavailable' | 'activation_evidence_missing'
  | 'stripe_credentials_missing' | 'stripe_account_mismatch' | 'stripe_api_version_mismatch' | 'price_ids_missing'
  | 'purchaser_contact_authority_held' | 'claim_code_lifetime_held' | 'sealing_key_missing';
export type CommerceReadiness = { [K in CommerceCapability]: { enabled: boolean; holds: CommerceHoldReason[] } };

/** The process flags every reviewed commerce surface requires, in the program-media host's posture. */
export function commerceFlagsOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.PROGRAM_COMMERCE_QUALIFICATION_ENABLED === 'true' && env.PHI_ALLOWED === 'false' && env.PRODUCTION_ACTIVATION === 'blocked'
    && env.PRODUCTION_WORKLOAD_MODE !== 'readiness_only' && env.CLINICAL_CONTRACT_FIXTURE !== '1';
}

/**
 * What the target and this process's secrets open, and why anything stays closed. Reading needs the
 * flags, the target and activation evidence; purchasing additionally needs the test-mode processor
 * credentials proving the target's account and version, at least one price id, the two decisions it
 * depends on, and the sealing key; the worker needs what purchasing needs (it settles and delivers).
 * The order's own offer still has to be published under reviewed access terms in the database.
 */
export function commerceReadiness(target: ProgramCommerceHostTarget | null, env: Record<string, string | undefined> = process.env): CommerceReadiness {
  const base: CommerceHoldReason[] = [];
  if (!commerceFlagsOn(env)) base.push('flags_off');
  if (!target) base.push('target_unavailable');
  else if (!target.activation.enabled) base.push('activation_evidence_missing');
  const purchase: CommerceHoldReason[] = [...base];
  if (target) {
    const secret = (env.STRIPE_TEST_SECRET_KEY ?? '').trim(), webhook = (env.STRIPE_TEST_WEBHOOK_SECRET ?? '').trim();
    if (env.STRIPE_TEST_MODE_ENABLED !== '1' || !/^(?:sk|rk)_test_[A-Za-z0-9]{8,}$/.test(secret) || !/^whsec_[A-Za-z0-9]{8,}$/.test(webhook)) purchase.push('stripe_credentials_missing');
    if ((env.STRIPE_TEST_ACCOUNT_ID ?? '').trim() !== target.processor.accountRef) purchase.push('stripe_account_mismatch');
    if ((env.STRIPE_API_VERSION_PINNED ?? '').trim() !== target.processor.apiVersion) purchase.push('stripe_api_version_mismatch');
    if (target.processor.priceRefs.length === 0) purchase.push('price_ids_missing');
    if (target.decisions.purchaserContactAuthority.state !== 'decided') purchase.push('purchaser_contact_authority_held');
    if (target.decisions.claimCodeLifetimeDays.state !== 'decided') purchase.push('claim_code_lifetime_held');
    if (!sealingKeyFromEnvironment(env)) purchase.push('sealing_key_missing');
  }
  return {
    learner: { enabled: base.length === 0, holds: base },
    purchasing: { enabled: purchase.length === 0, holds: purchase },
    worker: { enabled: purchase.length === 0, holds: purchase },
  };
}

/** The 32-byte claim sealing key the host injects from its secret store, base64; null when absent or malformed. */
export function sealingKeyFromEnvironment(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = (env.PROGRAM_COMMERCE_CLAIM_SEALING_KEY ?? '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const key = Buffer.from(raw, 'base64');
  return key.byteLength === 32 ? key : null;
}
