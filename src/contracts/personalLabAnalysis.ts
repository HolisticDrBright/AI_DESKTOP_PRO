import { z } from 'zod';

/** Durable owner copy of a completed lab analysis (original phase 2, "cloud
 * result publication"). The worker publishes it into the owner's personal
 * storage under lab_history consent once a result is final; the phone can
 * restore it later. It is a consumer-education copy, never a reviewed plan. */
export const PERSONAL_LAB_ANALYSIS_VERSION = 'personal-lab-analysis/1';
export const PERSONAL_LAB_ANALYSIS_MAX_BYTES = 262_144;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const personalLabAnalysisEnvelopeSchema = z.object({
  id: uuid,
  version: z.literal(PERSONAL_LAB_ANALYSIS_VERSION),
  jobId: uuid,
  kind: z.enum(['documents', 'saved']),
  completedAt: z.string().datetime(),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceStatus: z.literal('consumer_lab_analysis_unreviewed'),
  result: z.record(z.string(), z.unknown()),
}).strict();
export type PersonalLabAnalysisEnvelope = z.infer<typeof personalLabAnalysisEnvelopeSchema>;
