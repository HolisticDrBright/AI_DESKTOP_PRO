import {z} from 'zod';
export const CORRECTION_COLLECTIONS=['wellness_profiles','lifestyle_profiles','clinical_intakes','questionnaire_responses','contraindications',
  'symptom_logs','hormone_entries','reproductive_profiles','daily_adherence','meal_logs','subjective_rollups','weekly_checkins',
  'wearable_daily_records','adverse_event_reports','lab_observations','protocols','diet_preferences'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().min(1).max(999999999);
// A top-level key or a dotted path to a leaf; each segment is a plain key or a list index (0..9999).
export const CORRECTION_PATH_SEGMENTS=6;
/** A leaf that is a list of plain values may be replaced by another list of plain values, bounded. */
export const CORRECTION_LIST_MAX=200;
export function correctionPath(field:string):string[]|null{
  if(typeof field!=='string'||field.length<1||field.length>240)return null;
  const segments=field.split('.');
  if(segments.length<1||segments.length>CORRECTION_PATH_SEGMENTS||segments.some(s=>s.length<1||s.length>80||['__proto__','prototype','constructor'].includes(s)
    ||(/^[0-9-]/.test(s)&&!/^(0|[1-9][0-9]{0,3})$/.test(s))))return null;
  return segments;
}
export const isCorrectionScalar=(v:unknown):v is string|number|boolean=>['string','number','boolean'].includes(typeof v)&&(typeof v!=='number'||Number.isFinite(v));
export const isCorrectionScalarList=(v:unknown):v is (string|number|boolean)[]=>Array.isArray(v)&&v.length<=CORRECTION_LIST_MAX&&v.every(isCorrectionScalar);
const field=z.string().min(1).max(240).refine(v=>correctionPath(v)!==null);
const date=z.string().datetime({offset:true});
export const correctionInputSchema=z.object({
  version:z.literal('personal-correction/1'),collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  expectedRevision:revision,expectedPayloadSha256:hash,field,
  requestedValue:z.unknown().refine(v=>isCorrectionScalar(v)||isCorrectionScalarList(v),'A requested plain value or list of plain values is required'),
  reason:z.string().min(1).max(2000).refine(v=>v.trim().length>0),
}).strict();
export const correctionRecordSchema=z.object({collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  revision,payloadSha256:hash,payload:z.record(z.string(),z.unknown()),receivedAt:date}).strict();
// The owner's own request content travels back so the owner's device can write
// the exact successor; deployments before that overlay omit both fields.
export const correctionTargetSchema=z.object({collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  expectedRevision:revision,expectedPayloadSha256:hash,field,requestSha256:hash,
  requestedValue:z.unknown().optional(),reason:z.string().min(1).max(2000).optional()}).strict();
export const correctionResolutionSchema=z.object({outcome:z.enum(['applied','declined']),appliedRevision:revision.nullable(),
  appliedPayloadSha256:hash.nullable(),evidenceSha256:hash,explanation:z.string().min(1).max(2000),resolvedAt:date,
}).strict().refine(v=>v.outcome==='applied'?(v.appliedRevision!==null&&v.appliedPayloadSha256!==null):
  (v.appliedRevision===null&&v.appliedPayloadSha256===null));
export type CorrectionInput=z.infer<typeof correctionInputSchema>;
export type CorrectionRecord=z.infer<typeof correctionRecordSchema>;
export type CorrectionTarget=z.infer<typeof correctionTargetSchema>;
export type CorrectionResolution=z.infer<typeof correctionResolutionSchema>;
