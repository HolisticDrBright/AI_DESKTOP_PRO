if (typeof window !== 'undefined') throw new Error('reviewed commerce runtime is server-only');
import { SESv2Client } from '@aws-sdk/client-sesv2';
import type { RdsDataCommandClient } from '../../clinical-core/rds-data-database';
import { PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, createSqlCheckoutLedger } from '../program-checkout-ledger-sql';
import { PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, createSqlEducationLedger } from '../program-education-ledger-sql';
import { PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 } from '../program-commerce-authority';
import { createSqlProgramOfferLedger } from '../program-offer-ledger-sql';
import { createStripeCheckoutProcessor } from '../program-checkout-stripe';
import { ProcessorError, type ProgramCheckoutProcessor } from '../program-checkout-processor';
import { createProgramCheckout } from '../program-checkout';
import { createProgramSettlement } from '../program-settlement';
import { createClaimDelivery } from '../program-claim-delivery';
import { createCommerceWorker } from '../program-commerce-worker';
import { createEducationAccessService } from '../education-access-service';
import { createEducationProgressService } from '../education-progress-service';
import { unavailable, type PurchaseAvailability } from '../../../contracts/programOffers';
import type { ProgramOfferLedger } from '../program-offer-ledger';
import type { ConsumerSessionVerifier } from '../../learner/consumer-session';
import { cognitoConsumerSessionVerifier } from '../../learner/consumer-session';
import { commerceReadiness, sealingKeyFromEnvironment, type CommerceReadiness, type ProgramCommerceHostTarget } from './commerce-host-target';
import { commerceSessionsFromTarget } from './commerce-role-sessions';
import { createKeyedClaimSealer, createSesClaimDeliveryProvider, createStripePurchaserContactAuthority, type SesSend } from './commerce-connectors';
import { createLearnerMediaService, LearnerMediaError, type LearnerMediaLedger, type LearnerMediaStorage } from '../../programs/learner-media';
import { createSqlLearnerMediaLedger } from '../../programs/learner-media-ledger-sql';
import { createAwsLearnerMediaStorage } from '../../programs/aws-learner-media-storage';

/**
 * The reviewed program-commerce runtime, composed from ONE verified target and this process's
 * injected secrets. Every ledger is the existing SQL adapter; every service above it is the existing
 * service; each authority runs over its own reduced database session:
 *
 *   API session       offer availability, checkout admission, webhook intake, consumer access,
 *                     claim, exact curriculum and progress
 *   worker session    intake processing, reconciliation, settlement and expiry
 *   delivery session  the due sealed codes and the record of each attempt
 *   operator session  policy decisions and code replacement (operator tooling only; no request path)
 *
 * What it opens follows commerceReadiness(): reading (learner) needs the target and activation
 * evidence; purchasing and the worker additionally need the processor credentials proving the
 * target's account and version, price ids, the purchaser-contact and code-lifetime decisions, and the
 * sealing key. Whatever is not ready is absent from the returned runtime, never a degraded default.
 * An offer whose processor price is not one the target lists is held as unapproved, and the
 * processor refuses to create a session for it even if asked.
 */
export type ReviewedCommerceInputs = {
  target: ProgramCommerceHostTarget;
  env?: Record<string, string | undefined>;
  /** Injected for tests; the SDK client otherwise. */
  rdsClient?: RdsDataCommandClient;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sesSend?: SesSend;
  consumerSessions?: ConsumerSessionVerifier;
  /** Injected for tests; the AWS reader over the target's learner-media storage otherwise. */
  learnerMediaStorage?: LearnerMediaStorage;
  now?: () => Date;
};
/** Used only when the target names no learner media: the service answers `held` before any ledger call. */
const noMediaLedger: LearnerMediaLedger = { forLearner: async () => { throw new LearnerMediaError('service_unavailable'); }, forStaff: async () => { throw new LearnerMediaError('service_unavailable'); } };

export function createReviewedCommerceRuntime(inputs: ReviewedCommerceInputs) {
  const env = inputs.env ?? process.env;
  const { target } = inputs;
  const readiness: CommerceReadiness = commerceReadiness(target, env);
  if (!readiness.learner.enabled || !target.activation.enabled) return { readiness, learner: null, purchasing: null, worker: null } as const;
  const now = inputs.now ?? (() => new Date());
  const fetchImpl = inputs.fetch ?? ((input, init) => fetch(input, init));
  const sessions = commerceSessionsFromTarget(target, inputs.rdsClient);
  const evidence = target.activation;
  const chain = { activation: evidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, checkoutRecoveryCandidateSha256: PROGRAM_CHECKOUT_RECOVERY_SCHEMA_CANDIDATE_SHA256, commerceAuthorityCandidateSha256: PROGRAM_COMMERCE_AUTHORITY_SCHEMA_CANDIDATE_SHA256 };
  const education = createSqlEducationLedger({
    database: sessions.api, worker: sessions.worker, delivery: sessions.delivery, operator: sessions.operator, ...chain,
    educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, educationDeliveryCandidateSha256: PROGRAM_EDUCATION_DELIVERY_SCHEMA_CANDIDATE_SHA256, educationProgressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256,
  });
  const decidedDays = target.decisions.claimCodeLifetimeDays.state === 'decided' ? target.decisions.claimCodeLifetimeDays.value : undefined;
  const key = sealingKeyFromEnvironment(env);
  const sealer = key ? createKeyedClaimSealer(key, target.sealing.keyRef) : null;
  // Reading never settles or issues a code, so the reading settlement has no sealer; only the worker's does.
  const readingSettlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: target.processor.accountRef, now, sealer: null });
  const accessService = createEducationAccessService({ settlement: readingSettlement, activation: evidence, checkoutCandidateSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, educationCandidateSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256, expectedCheckoutSha256: PROGRAM_CHECKOUT_SCHEMA_CANDIDATE_SHA256, expectedEducationSha256: PROGRAM_EDUCATION_SCHEMA_CANDIDATE_SHA256 });
  const progressService = createEducationProgressService({ ledger: education, activation: evidence, progressCandidateSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256, expectedProgressSha256: PROGRAM_EDUCATION_PROGRESS_SCHEMA_CANDIDATE_SHA256 });
  const verify = inputs.consumerSessions ?? cognitoConsumerSessionVerifier(target.consumer);
  // Lesson media opens only when the target names it; then the ledger is the reviewed SQL read on the API session and storage is the scoped reader.
  const media = createLearnerMediaService(target.learnerMedia
    ? { ledger: createSqlLearnerMediaLedger({ database: sessions.api, candidateSha256: target.learnerMedia.candidate }), storage: inputs.learnerMediaStorage ?? createAwsLearnerMediaStorage({ config: target.learnerMedia.storage }) }
    : { ledger: noMediaLedger, storage: null });
  const learner = { verify, services: () => ({ education: accessService, progress: progressService, media }) } as const;
  if (!readiness.purchasing.enabled || !sealer || decidedDays === undefined || target.decisions.purchaserContactAuthority.state !== 'decided') {
    return { readiness, learner, purchasing: null, worker: null } as const;
  }

  const allowed = new Set(target.processor.priceRefs);
  const stripe = createStripeCheckoutProcessor({ secretKey: (env.STRIPE_TEST_SECRET_KEY ?? '').trim(), accountRef: target.processor.accountRef, apiVersion: target.processor.apiVersion }, fetchImpl);
  // The processor charges only a price the target lists; the offer ledger's own approval still applies first.
  const processor: ProgramCheckoutProcessor = {
    ...stripe,
    async createSession(creation) {
      if (!allowed.has(creation.request.priceRef)) throw new ProcessorError('refused');
      return stripe.createSession(creation);
    },
  };
  const sqlOffers = createSqlProgramOfferLedger({ database: sessions.api, activation: evidence, identity: () => { throw new Error('staff_offer_commands_not_in_reviewed_runtime'); } });
  // Visitors only ask availability here. Staff offer commands need a verified workforce identity, which this runtime does not have.
  const offers: ProgramOfferLedger = {
    execute: async () => { throw new Error('staff_offer_commands_not_in_reviewed_runtime'); },
    read: async () => null,
    async availability(organizationId, programId): Promise<PurchaseAvailability> {
      const answer = await sqlOffers.availability(organizationId, programId);
      return answer.available && !allowed.has(answer.providerPriceRef) ? unavailable('provider_mapping_unapproved') : answer;
    },
  };
  const orders = createSqlCheckoutLedger({ database: sessions.api, ...chain });
  const workerOrders = createSqlCheckoutLedger({ database: sessions.worker, authority: 'worker', ...chain });
  const publicOrigin = target.consumer.desktopOrigin;
  const checkout = createProgramCheckout({ offers, ledger: orders, processor, publicOrigin, now });
  const workerCheckout = createProgramCheckout({ offers, ledger: workerOrders, processor, publicOrigin, now });
  const settlement = createProgramSettlement({ ledger: education, curriculumContent: async () => null, expectedAccountRef: target.processor.accountRef, now, sealer, claimValidityDays: decidedDays });
  const contacts = createStripePurchaserContactAuthority({ secretKey: (env.STRIPE_TEST_SECRET_KEY ?? '').trim(), apiVersion: target.processor.apiVersion, orders: workerOrders, fetch: fetchImpl });
  const ses = inputs.sesSend ?? (() => { const client = new SESv2Client({ region: target.delivery.region, maxAttempts: 1 }); return (command => client.send(command)) as SesSend; })();
  const provider = createSesClaimDeliveryProvider({ send: ses, fromAddress: target.delivery.fromAddress, configurationSet: target.delivery.configurationSet, messageIdDomain: target.delivery.messageIdDomain });
  const delivery = createClaimDelivery({ ledger: education, sealer, contacts, provider, now });
  const worker = createCommerceWorker({ ledger: workerOrders, checkout: workerCheckout, settlement, delivery, now });
  const expected = { accountRef: target.processor.accountRef, apiVersion: target.processor.apiVersion };
  return {
    readiness, learner,
    purchasing: { kind: 'reviewed' as const, checkout, expected, ledger: orders, education, settlement: readingSettlement, worker, offers },
    worker,
  } as const;
}
export type ReviewedCommerceRuntime = ReturnType<typeof createReviewedCommerceRuntime>;
