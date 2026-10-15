import { z } from 'zod';
import { productActionId, productActionRefusal, productActionRequest } from './fullscriptConsumerAction';

/**
 * A purchase action for ONE program step (program-step-purchase/1). This module is a byte-identical mirror between
 * AI_DESKTOP_PRO src/contracts/ and AI_LONGEVITY_PRO_V2 expo/contracts/; both suites pin the same digest.
 *
 * It is ADDITIVE to fullscript-consumer-action/2, which is unchanged: the action itself is that contract's request,
 * carried beside the binding of the step it is for. The binding names what the person was shown:
 *   the enrollment, the exact step, the enrollment revision and the review's plan revision, the program content digest,
 *   the care connection (the clinic and patient link), and the step's catalog stable id, version and target.
 * The server reads its own CURRENT program review at issue and again at redemption and refuses unless this exact step
 * is available in it under this exact binding. A step held for a lab result, a conflicting result, a duplicate, a later
 * revision, another program version, a withdrawn or paused enrollment, another owner's, clinic's or link's step, or
 * another catalog product is refused. Nothing here carries an address, a price or a purchase link: the destination is
 * returned only by the consumer-action redemption, after every check, and only under a reviewed purchase release.
 *
 * A step is purchasable only when the clinic has set a price for its program (program_price_unset otherwise). Prices
 * for separately purchased programs are not decided, so today every step refuses with it; booking a consultation is not
 * a purchase and is unaffected.
 *
 * NOT RELEASED. PROGRAM_STEP_PURCHASE_RELEASED is false and the Desktop refuses every request until activation evidence
 * names the reviewed candidates (infra/aws-clinical-core/production-candidates/program-step-purchase.sql and its priced
 * successor program-step-purchase-priced.sql).
 */
export const PROGRAM_STEP_PURCHASE = 'program-step-purchase/1' as const;
export const PROGRAM_STEP_PURCHASE_RELEASED = false as boolean;

const uuid = z.string().uuid();
export const programStepBinding = z.object({
  enrollmentId: uuid,
  itemId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  assignmentRevision: z.string().regex(/^[0-9]{1,18}$/),
  planRevision: z.string().regex(/^[A-Za-z0-9:._-]{1,300}$/),
  sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  connectionId: uuid,
  catalog: z.object({
    stableId: z.string().regex(/^prd_[a-z0-9][a-z0-9_-]{2,95}$/), version: z.number().int().min(1).max(999_999_999),
    target: z.literal('production-clinical'),
  }).strict(),
}).strict();
export type ProgramStepBinding = z.infer<typeof programStepBinding>;

export const programStepPurchaseRequest = z.object({
  contract: z.literal(PROGRAM_STEP_PURCHASE), step: programStepBinding, action: productActionRequest,
}).strict().superRefine((request, c) => {
  // The action is for the step's own catalog product and version, never another one carried alongside it.
  if (request.action.binding.productStableId !== request.step.catalog.stableId || request.action.binding.productVersion !== request.step.catalog.version)
    c.addIssue({ code: 'custom', message: 'program_step_product_mismatch' });
});
export type ProgramStepPurchaseRequest = z.infer<typeof programStepPurchaseRequest>;
export const programStepRedemptionRequest = z.object({ contract: z.literal(PROGRAM_STEP_PURCHASE), actionId: productActionId }).strict();
export type ProgramStepRedemptionRequest = z.infer<typeof programStepRedemptionRequest>;

/** Why a step is not purchasable now. Reasons only: never a value, a range or a reading. */
export const PROGRAM_STEP_REFUSALS = [
  'program_step_purchase_disabled', 'program_step_refused', 'program_step_withdrawn', 'program_step_superseded', 'program_step_stale',
  'program_step_not_active', 'program_step_not_current', 'program_step_catalog_changed', 'program_review_stale', 'program_step_lab_held',
  'program_step_conflict', 'program_step_duplicate', 'program_step_held', 'program_step_unavailable', 'program_price_unset',
] as const;
export type ProgramStepRefusal = typeof PROGRAM_STEP_REFUSALS[number];
export const programStepPurchaseRefusal = z.enum([...PROGRAM_STEP_REFUSALS, ...productActionRefusal.options]);
export type ProgramStepPurchaseRefusal = z.infer<typeof programStepPurchaseRefusal>;
/** What a client is told: another owner's, clinic's or link's step does not exist as far as this caller knows. */
export function publicProgramStepRefusal(reason: ProgramStepPurchaseRefusal): ProgramStepPurchaseRefusal {
  return reason === 'other_account' ? 'action_not_found' : reason;
}
