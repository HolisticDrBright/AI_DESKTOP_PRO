import { z } from 'zod';
/**
 * Activation evidence for the production program assignment service (production-program-activation/1).
 *
 * The production adapter is disabled unless it is constructed with evidence that parses here AND names
 * the exact schema candidate the adapter was built against. The evidence is a record of a review that
 * happened elsewhere; nothing in this file performs or implies that review, and the default export is
 * the disabled state. Enabling production programs is a separately reviewed change by the operator.
 */
export const PRODUCTION_PROGRAM_ACTIVATION = 'production-program-activation/1' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const productionProgramActivation = z.discriminatedUnion('enabled', [
  z.object({ contract: z.literal(PRODUCTION_PROGRAM_ACTIVATION), enabled: z.literal(false) }).strict(),
  z.object({
    contract: z.literal(PRODUCTION_PROGRAM_ACTIVATION), enabled: z.literal(true),
    target: z.literal('production-clinical'),
    /** SHA-256 of infra/aws-clinical-core/production-candidates/production-program-assignments.sql as reviewed. */
    schemaCandidateSha256: digest,
    /** SHA-256 of the review record the operator holds; the adapter never reads it, it binds to it. */
    evidenceSha256: digest,
    reviewedBy: z.string().trim().min(1).max(200),
    reviewedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type ProductionProgramActivation = z.infer<typeof productionProgramActivation>;
export const DISABLED_PRODUCTION_PROGRAM_ACTIVATION: ProductionProgramActivation = Object.freeze({ contract: PRODUCTION_PROGRAM_ACTIVATION, enabled: false });
