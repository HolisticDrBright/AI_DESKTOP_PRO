import { z } from 'zod';

/**
 * Activation evidence for program commerce (program-commerce-activation/1): the offer ledger, the
 * checkout boundary and the settlement path are all disabled unless constructed with evidence that
 * parses here AND names the exact BLOCKED candidate they were built against. The evidence records a
 * review that happened elsewhere; this module performs none, and its default is the disabled state.
 * Enabling program commerce is a separately reviewed change by the operator, and even then the
 * database's own activation row (which the API role cannot write) must agree.
 */
export const PROGRAM_COMMERCE_ACTIVATION = 'program-commerce-activation/1' as const;
/** SHA-256 of infra/aws-clinical-core/source-candidates/program-offer-revisions.sql. A test holds this equal to the file. */
export const PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256 = '4973461564e6812906403525cb3aa109d6fd569eec159c9400fcf568a90b321f';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const programCommerceActivation = z.discriminatedUnion('enabled', [
  z.object({ contract: z.literal(PROGRAM_COMMERCE_ACTIVATION), enabled: z.literal(false) }).strict(),
  z.object({
    contract: z.literal(PROGRAM_COMMERCE_ACTIVATION), enabled: z.literal(true),
    target: z.enum(['synthetic-staging']),
    schemaCandidateSha256: digest,
    evidenceSha256: digest,
    reviewedBy: z.string().trim().min(1).max(200),
    reviewedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type ProgramCommerceActivation = z.infer<typeof programCommerceActivation>;
export const DISABLED_PROGRAM_COMMERCE_ACTIVATION: ProgramCommerceActivation = Object.freeze({ contract: PROGRAM_COMMERCE_ACTIVATION, enabled: false });

export function programCommerceActivationState(evidence: unknown): ProgramCommerceActivation {
  const parsed = programCommerceActivation.safeParse(evidence ?? DISABLED_PROGRAM_COMMERCE_ACTIVATION);
  if (!parsed.success) return DISABLED_PROGRAM_COMMERCE_ACTIVATION;
  if (parsed.data.enabled && parsed.data.schemaCandidateSha256 !== PROGRAM_OFFER_SCHEMA_CANDIDATE_SHA256) return DISABLED_PROGRAM_COMMERCE_ACTIVATION;
  return parsed.data;
}
