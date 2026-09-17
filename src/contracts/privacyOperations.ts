import {z} from 'zod';
import {correctionTargetSchema,correctionResolutionSchema} from './personalCorrection';
const id=z.string().uuid();
export const privacyOperationSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('list'),after:id.optional(),includeClosed:z.boolean()}).strict(),
  z.object({action:z.literal('detail'),privacyRequestId:id}).strict(),
  z.object({action:z.literal('resolve'),privacyRequestId:id,outcome:z.enum(['applied','declined']),
    appliedRevision:z.number().int().min(1).max(999999999).nullable(),
    explanation:z.string().trim().min(1).max(2000)}).strict().refine(v=>v.outcome==='applied'?v.appliedRevision!==null:v.appliedRevision===null),
]);
export type PrivacyOperation=z.infer<typeof privacyOperationSchema>;
const row=z.object({privacyRequestId:id,ownerId:id,kind:z.enum(['deletion','correction']),
  status:z.enum(['submitted','held','in_progress','completed','refused']),
  submittedAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true})}).strict();
export const privacyQueueSchema=z.object({items:z.array(row).max(25),nextAfter:id.nullable()}).strict();
export const privacyDetailSchema=row.extend({legalHold:z.boolean(),fulfillment:z.array(z.object({
  store:z.enum(['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
    'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit']),
  outcome:z.enum(['tombstoned','purged','not_applicable','pending','refused','not_enumerable','retained_by_policy']),
  evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),recordedAt:z.string().datetime({offset:true}),
}).strict()).max(200),correction:z.object({
  target:correctionTargetSchema,reason:z.string().min(1).max(2000),requestedValue:z.unknown(),
  originalAvailable:z.boolean(),originalValue:z.unknown(),currentRevision:z.number().int().positive().nullable(),
  currentDeleted:z.boolean(),currentValue:z.unknown(),resolution:correctionResolutionSchema.nullable(),
}).strict().nullable()}).strict().refine(v=>{
  if(v.correction===null)return true; // Legacy request, explicitly not resolvable.
  if(v.kind!=='correction')return false;
  const r=v.correction.resolution;
  if(!r)return v.status!=='completed'&&v.status!=='refused';
  return r.outcome==='applied'?v.status==='completed'&&r.appliedRevision!>v.correction.target.expectedRevision:v.status==='refused';
});
export type PrivacyQueue=z.infer<typeof privacyQueueSchema>;
export type PrivacyDetail=z.infer<typeof privacyDetailSchema>;
export function parsePrivacyOperationResult(input:PrivacyOperation,raw:unknown):PrivacyQueue|PrivacyDetail{
  if(input.action==='list'){
    const value=privacyQueueSchema.parse(raw);let previous=input.after?.toLowerCase()??'';
    for(const item of value.items){if(item.privacyRequestId.toLowerCase()<=previous
      ||!input.includeClosed&&['completed','refused'].includes(item.status))throw new Error('privacy_response_invalid');
      previous=item.privacyRequestId.toLowerCase();}
    if(value.nextAfter!==(value.items.length===25?value.items.at(-1)!.privacyRequestId:null))throw new Error('privacy_response_invalid');
    return value;
  }
  const value=privacyDetailSchema.parse(raw);
  if(value.privacyRequestId!==input.privacyRequestId)throw new Error('privacy_response_invalid');
  if(input.action==='resolve'){
    const r=value.correction?.resolution;
    if(!r||r.outcome!==input.outcome||r.appliedRevision!==input.appliedRevision||r.explanation!==input.explanation
      ||value.status!==(input.outcome==='applied'?'completed':'refused'))throw new Error('privacy_response_invalid');
  }
  return value;
}
