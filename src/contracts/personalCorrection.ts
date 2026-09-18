import {z} from 'zod';
export const CORRECTION_COLLECTIONS=['wellness_profiles','lifestyle_profiles','clinical_intakes','questionnaire_responses','contraindications',
  'symptom_logs','hormone_entries','reproductive_profiles','daily_adherence','meal_logs','subjective_rollups','weekly_checkins',
  'wearable_daily_records','adverse_event_reports','lab_observations','protocols','diet_preferences'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(1).max(999999999);
const field=z.string().min(1).max(80).refine(v=>!['__proto__','prototype','constructor'].includes(v));
const date=z.string().datetime({offset:true});
export const correctionInputSchema=z.object({
  version:z.literal('personal-correction/1'),collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  expectedRevision:revision,expectedPayloadSha256:hash,field,
  requestedValue:z.unknown().refine(v=>v!==undefined,'A requested value is required'),
  reason:z.string().min(1).max(2000).refine(v=>v.trim().length>0),
}).strict();
export const correctionRecordSchema=z.object({collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  revision,payloadSha256:hash,payload:z.record(z.string(),z.unknown()),receivedAt:date}).strict();
export const correctionTargetSchema=z.object({collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  expectedRevision:revision,expectedPayloadSha256:hash,field,requestSha256:hash}).strict();
export const correctionResolutionSchema=z.object({outcome:z.enum(['applied','declined']),appliedRevision:revision.nullable(),
  appliedPayloadSha256:hash.nullable(),evidenceSha256:hash,explanation:z.string().min(1).max(2000),resolvedAt:date,
}).strict().refine(v=>v.outcome==='applied'?(v.appliedRevision!==null&&v.appliedPayloadSha256!==null):
  (v.appliedRevision===null&&v.appliedPayloadSha256===null));
export type CorrectionInput=z.infer<typeof correctionInputSchema>;
export type CorrectionRecord=z.infer<typeof correctionRecordSchema>;
export type CorrectionTarget=z.infer<typeof correctionTargetSchema>;
export type CorrectionResolution=z.infer<typeof correctionResolutionSchema>;
