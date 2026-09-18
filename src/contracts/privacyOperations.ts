import {z} from 'zod';
import {correctionTargetSchema,correctionResolutionSchema} from './personalCorrection';
const id=z.string().uuid();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const policyVersion=z.string().trim().min(1).max(200);
export const privacyOperationSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('list'),after:id.optional(),includeClosed:z.boolean()}).strict(),
  z.object({action:z.literal('detail'),privacyRequestId:id}).strict(),
  z.object({action:z.literal('externalInventory'),privacyRequestId:id,inventoryId:id,store:z.enum(['labs','voice']),
    expectedRevision:z.number().int().min(0).max(10000)}).strict(),
  z.object({action:z.literal('resolve'),privacyRequestId:id,outcome:z.enum(['applied','declined']),
    appliedRevision:z.number().int().min(1).max(999999999).nullable(),
    explanation:z.string().trim().min(1).max(2000)}).strict().refine(v=>v.outcome==='applied'?v.appliedRevision!==null:v.appliedRevision===null),
  z.object({action:z.literal('previewPersonalPurge'),privacyRequestId:id,policyVersion}).strict(),
  z.object({action:z.literal('purgePersonal'),privacyRequestId:id,commandId:id,policyVersion,
    policySha256:hash,inventorySha256:hash,confirmation:z.literal('PURGE PERSONAL HISTORY')}).strict(),
]);
export type PrivacyOperation=z.infer<typeof privacyOperationSchema>;
const row=z.object({privacyRequestId:id,ownerId:id,kind:z.enum(['deletion','correction']),
  status:z.enum(['submitted','held','in_progress','completed','refused']),
  submittedAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true})}).strict();
export const privacyQueueSchema=z.object({items:z.array(row).max(25),nextAfter:id.nullable()}).strict();
export const externalInventorySummarySchema=z.object({inventoryId:id,privacyRequestId:id,store:z.enum(['labs','voice']),
  revision:z.number().int().min(0).max(10000),scanned:z.number().int().min(0).max(100025),items:z.number().int().min(0).max(10025),
  issues:z.number().int().min(0).max(100025),state:z.enum(['scanning','exhausted','bounded']),sourceSha256:hash,evidenceSha256:hash,
  createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true}),readOnly:z.literal(true),
  completeAccountInventory:z.literal(false),requiresReconciliation:z.literal(true)}).strict().refine(v=>v.items+v.issues<=v.scanned);
export type ExternalInventorySummary=z.infer<typeof externalInventorySummarySchema>;
export const privacyDetailSchema=row.extend({legalHold:z.boolean(),fulfillment:z.array(z.object({
  store:z.enum(['personal_records','personal_consents','active_plan','lab_jobs_and_documents','voice_jobs_and_transcripts',
    'identity','clinic_records','device_caches_and_recovery_archives','backups_and_audit']),
  outcome:z.enum(['tombstoned','purged','not_applicable','pending','refused','not_enumerable','retained_by_policy']),
  evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),recordedAt:z.string().datetime({offset:true}),
}).strict()).max(200),correction:z.object({
  target:correctionTargetSchema,reason:z.string().min(1).max(2000),requestedValue:z.unknown(),
  originalAvailable:z.boolean(),originalValue:z.unknown(),currentRevision:z.number().int().positive().nullable(),
  currentDeleted:z.boolean(),currentValue:z.unknown(),resolution:correctionResolutionSchema.nullable(),
}).strict().nullable(),externalInventories:z.array(externalInventorySummarySchema).max(20).default([])}).strict().refine(v=>{
  if(v.externalInventories.some(i=>i.privacyRequestId!==v.privacyRequestId))return false;
  if(v.correction===null)return true; // Legacy request, explicitly not resolvable.
  if(v.kind!=='correction')return false;
  const r=v.correction.resolution;
  if(!r)return v.status!=='completed'&&v.status!=='refused';
  return r.outcome==='applied'?v.status==='completed'&&r.appliedRevision!>v.correction.target.expectedRevision:v.status==='refused';
});
export type PrivacyQueue=z.infer<typeof privacyQueueSchema>;
export type PrivacyDetail=z.infer<typeof privacyDetailSchema>;
const purgeBase=z.object({privacyRequestId:id,policyVersion,policySha256:hash,inventorySha256:hash,
  records:z.number().int().min(0).max(100000),consents:z.number().int().min(0).max(100000),
  activePlans:z.number().int().min(0).max(100000),planHistory:z.number().int().min(0).max(100000),completeAccountDeletion:z.literal(false)}).strict();
export const personalPurgePreviewSchema=purgeBase.extend({policyContent:z.string().min(1).max(50000)}).strict();
export const personalPurgeReceiptSchema=purgeBase.extend({commandId:id,outcome:z.literal('purged'),
  verifiedAt:z.string().datetime({offset:true}),evidenceSha256:hash}).strict();
export type PersonalPurgePreview=z.infer<typeof personalPurgePreviewSchema>;
export type PersonalPurgeReceipt=z.infer<typeof personalPurgeReceiptSchema>;
export function parsePrivacyOperationResult(input:PrivacyOperation,raw:unknown):PrivacyQueue|PrivacyDetail|PersonalPurgePreview|PersonalPurgeReceipt|ExternalInventorySummary{
  if(input.action==='externalInventory'){
    const value=externalInventorySummarySchema.parse(raw);
    if(value.inventoryId!==input.inventoryId||value.privacyRequestId!==input.privacyRequestId||value.store!==input.store
      ||![input.expectedRevision,input.expectedRevision+1].includes(value.revision))throw new Error('privacy_response_invalid');
    return value;
  }
  if(input.action==='previewPersonalPurge'||input.action==='purgePersonal'){
    const value=input.action==='previewPersonalPurge'?personalPurgePreviewSchema.parse(raw):personalPurgeReceiptSchema.parse(raw);
    if(value.privacyRequestId!==input.privacyRequestId||value.policyVersion!==input.policyVersion)throw new Error('privacy_response_invalid');
    if(input.action==='purgePersonal'&&(!('commandId' in value)||value.commandId!==input.commandId
      ||value.policySha256!==input.policySha256||value.inventorySha256!==input.inventorySha256))throw new Error('privacy_response_invalid');
    return value;
  }
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
