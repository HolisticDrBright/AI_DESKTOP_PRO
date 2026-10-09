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
/** Lists of structured entries (medications, supplements): each entry is a flat record of plain values or lists of plain values,
 * with at most this many keys. A whole list may be replaced by another; the operator sees a per-entry diff, keyed by a unique
 * string `id` when every entry on both sides carries one, otherwise by position. */
export const CORRECTION_ENTRY_KEYS_MAX=40;
export type CorrectionEntry=Record<string,string|number|boolean|(string|number|boolean)[]>;
const safeEntryKey=(k:string)=>k.length>=1&&k.length<=80&&!k.includes('.')&&!/^[0-9-]/.test(k)&&!['__proto__','constructor','prototype'].includes(k);
export function isCorrectionEntry(v:unknown):v is CorrectionEntry{
  if(v===null||typeof v!=='object'||Array.isArray(v))return false;
  const keys=Object.keys(v);
  return keys.length>=1&&keys.length<=CORRECTION_ENTRY_KEYS_MAX&&keys.every(k=>safeEntryKey(k)&&(isCorrectionScalar((v as Record<string,unknown>)[k])||isCorrectionScalarList((v as Record<string,unknown>)[k])));
}
export const isCorrectionEntryList=(v:unknown):v is CorrectionEntry[]=>Array.isArray(v)&&v.length<=CORRECTION_LIST_MAX&&v.every(isCorrectionEntry);
export type CorrectionEntryListDiff={identity:'id'|'index';added:{key:string;entry:CorrectionEntry}[];removed:{key:string;entry:CorrectionEntry}[];
  changed:{key:string;before:CorrectionEntry;after:CorrectionEntry;fields:string[]}[];unchanged:number};
const sameLeaf=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every((v,i)=>Object.is(v,b[i])):Object.is(a,b);
export function correctionEntryListDiff(prior:CorrectionEntry[],requested:CorrectionEntry[]):CorrectionEntryListDiff{
  const ids=(list:CorrectionEntry[])=>list.map(e=>typeof e.id==='string'?e.id:null);
  const priorIds=ids(prior),requestedIds=ids(requested);
  const byId=[...priorIds,...requestedIds].every(id=>id!==null)&&new Set(priorIds).size===prior.length&&new Set(requestedIds).size===requested.length;
  const key=(list:CorrectionEntry[],i:number)=>byId?String(list[i].id):String(i);
  const before=new Map(prior.map((e,i)=>[key(prior,i),e])),after=new Map(requested.map((e,i)=>[key(requested,i),e]));
  const diff:CorrectionEntryListDiff={identity:byId?'id':'index',added:[],removed:[],changed:[],unchanged:0};
  for(const [k,entry] of after){
    const b=before.get(k);
    if(!b){diff.added.push({key:k,entry});continue;}
    const fields=[...new Set([...Object.keys(b),...Object.keys(entry)])].filter(f=>!sameLeaf(b[f],entry[f]));
    if(fields.length)diff.changed.push({key:k,before:b,after:entry,fields});else diff.unchanged++;
  }
  for(const [k,entry] of before)if(!after.has(k))diff.removed.push({key:k,entry});
  return diff;
}
const field=z.string().min(1).max(240).refine(v=>correctionPath(v)!==null);
const date=z.string().datetime({offset:true});
export const correctionInputSchema=z.object({
  version:z.literal('personal-correction/1'),collection:z.enum(CORRECTION_COLLECTIONS),recordId:z.string().uuid(),
  expectedRevision:revision,expectedPayloadSha256:hash,field,
  requestedValue:z.unknown().refine(v=>isCorrectionScalar(v)||isCorrectionScalarList(v)||isCorrectionEntryList(v),'A requested plain value, list of plain values or list of flat entries is required'),
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
