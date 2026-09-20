import {z} from 'zod';
import {correctionTargetSchema,correctionResolutionSchema} from './personalCorrection';
import {disputeTargetSchema,disputeResolutionSchema,DISPUTE_OUTCOMES} from './personalDispute';
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
  z.object({action:z.literal('purgeExternal'),privacyRequestId:id,inventoryId:id,store:z.enum(['labs','voice']),
    maxItems:z.number().int().min(1).max(10),confirmation:z.literal('PURGE EXTERNAL STORE')}).strict(),
  z.object({action:z.literal('recordDisposition'),privacyRequestId:id,store:z.enum(['clinic_records','device_caches_and_recovery_archives']),
    outcome:z.enum(['not_applicable','not_enumerable','pending','refused']),evidenceSha256:hash}).strict(),
  z.object({action:z.literal('retainByPolicy'),privacyRequestId:id,store:z.enum(['backups_and_audit','clinic_records']),
    evidenceSha256:hash,policyVersion}).strict(),
  z.object({action:z.literal('completeDeletion'),privacyRequestId:id,confirmation:z.literal('COMPLETE DELETION REQUEST')}).strict(),
  z.object({action:z.literal('purgeIdentity'),privacyRequestId:id,confirmation:z.literal('DELETE CONSUMER IDENTITY')}).strict(),
  z.object({action:z.literal('cleanupExports'),maxItems:z.number().int().min(1).max(10)}).strict(),
  z.object({action:z.literal('reconcileExports'),maxItems:z.number().int().min(1).max(10)}).strict(),
  z.object({action:z.literal('exportBacklog')}).strict(),
  z.object({action:z.literal('resolveDispute'),privacyRequestId:id,outcome:z.enum(DISPUTE_OUTCOMES),amendmentSha256:hash.nullable(),
    explanation:z.string().trim().min(1).max(2000)}).strict().refine(v=>(v.outcome==='declined')===(v.amendmentSha256===null)),
]);
export type PrivacyOperation=z.infer<typeof privacyOperationSchema>;
const row=z.object({privacyRequestId:id,ownerId:id,kind:z.enum(['deletion','correction','dispute']),
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
}).strict().nullable(),externalInventories:z.array(externalInventorySummarySchema).max(20).default([]),
  // Disputes (migration 20260920170000): the target and the owner's statement; a resolution once recorded. Older deployments omit the key.
  dispute:z.object({target:disputeTargetSchema,statement:z.string().min(1).max(4000),resolution:disputeResolutionSchema.nullable()}).strict().nullable().default(null)}).strict().refine(v=>{
  if(v.externalInventories.some(i=>i.privacyRequestId!==v.privacyRequestId))return false;
  if(v.dispute!==null&&v.kind!=='dispute')return false;
  if(v.dispute?.resolution&&(v.dispute.resolution.outcome==='declined'?v.status!=='refused':v.status!=='completed'))return false;
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
const count=z.number().int().min(0).max(10025);
export const externalPurgeSummarySchema=z.object({inventoryId:id,privacyRequestId:id,store:z.enum(['labs','voice']),
  inventoryState:z.enum(['scanning','exhausted','bounded']),total:count,cleaned:count,notFound:count,refused:count,claimed:count,remaining:count,
  state:z.enum(['inventory_incomplete','in_progress','complete']),evidenceSha256:hash,updatedAt:z.string().datetime({offset:true}),
  completeStorePurge:z.literal(false),fulfillmentStore:z.enum(['lab_jobs_and_documents','voice_jobs_and_transcripts']).optional(),
  fulfillmentOutcome:z.enum(['purged','not_applicable','pending']).optional()}).strict()
  .refine(v=>v.cleaned+v.notFound+v.refused+v.claimed<=v.total&&v.remaining===v.total-v.cleaned-v.notFound)
  .refine(v=>(v.state==='complete')===(v.remaining===0&&v.inventoryState!=='scanning'))
  .refine(v=>(v.fulfillmentStore===undefined)===(v.fulfillmentOutcome===undefined)&&(v.fulfillmentStore===undefined||v.state==='complete'));
export type ExternalPurgeSummary=z.infer<typeof externalPurgeSummarySchema>;
/** One assigned-operator retention pass over finished export jobs: counts and per-job outcomes only, never keys, owners or content.
 * `deferred` jobs failed this pass and are due again after backoff; `pending` jobs are still settling or the record was lost. */
const finished=z.enum(['failed','cancelled','expired']);
export const exportCleanupSummarySchema=z.object({cleaned:z.number().int().min(0).max(10),remaining:z.number().int().min(0).max(10),deferred:z.number().int().min(0).max(10),
  items:z.array(z.object({jobId:id,status:finished,outcome:z.enum(['deleted','pending','deferred'])}).strict()).max(10)}).strict()
  .refine(v=>v.cleaned===v.items.filter(i=>i.outcome==='deleted').length&&v.deferred===v.items.filter(i=>i.outcome==='deferred').length
    &&v.remaining===v.items.filter(i=>i.outcome!=='deleted').length);
export type ExportCleanupSummary=z.infer<typeof exportCleanupSummarySchema>;
/** Reconciliation of certified removals after the settlement window: confirmed, or reopened because something reappeared under the key. */
export const exportReconcileSummarySchema=z.object({confirmed:z.number().int().min(0).max(10),reopened:z.number().int().min(0).max(10),pending:z.number().int().min(0).max(10),
  items:z.array(z.object({jobId:id,status:finished,outcome:z.enum(['confirmed','reopened','pending'])}).strict()).max(10)}).strict()
  .refine(v=>['confirmed','reopened','pending'].every(k=>v[k as 'confirmed']===v.items.filter(i=>i.outcome===k).length));
export type ExportReconcileSummary=z.infer<typeof exportReconcileSummarySchema>;
const backlogCount=z.number().int().min(0).max(100000000);
export const exportBacklogSchema=z.object({packaging:backlogCount,downloadable:backlogCount,downloadExpired:backlogCount,cleanupPending:backlogCount,settling:backlogCount,
  deferred:backlogCount,removalRecorded:backlogCount,removalVerified:backlogCount,reconcileDue:backlogCount,reopened:backlogCount,retainedUnderHold:backlogCount,
  oldestOverdueSeconds:z.number().int().min(0),oldestPendingSince:z.string().datetime({offset:true}).nullable(),measuredAt:z.string().datetime({offset:true}),
  scope:z.enum(['assigned_owners','all_owners'])}).strict();
export type ExportBacklog=z.infer<typeof exportBacklogSchema>;
export type PersonalPurgePreview=z.infer<typeof personalPurgePreviewSchema>;
export type PersonalPurgeReceipt=z.infer<typeof personalPurgeReceiptSchema>;
export function parsePrivacyOperationResult(input:PrivacyOperation,raw:unknown):PrivacyQueue|PrivacyDetail|PersonalPurgePreview|PersonalPurgeReceipt|ExternalInventorySummary|ExternalPurgeSummary|ExportCleanupSummary|ExportReconcileSummary|ExportBacklog{
  if(input.action==='cleanupExports'){
    const value=exportCleanupSummarySchema.parse(raw);
    if(value.items.length>input.maxItems)throw new Error('privacy_response_invalid');
    return value;
  }
  if(input.action==='reconcileExports'){
    const value=exportReconcileSummarySchema.parse(raw);
    if(value.items.length>input.maxItems)throw new Error('privacy_response_invalid');
    return value;
  }
  if(input.action==='exportBacklog'){
    const value=exportBacklogSchema.parse(raw);
    if(value.scope!=='assigned_owners')throw new Error('privacy_response_invalid');
    return value;
  }
  if(input.action==='purgeExternal'){
    const value=externalPurgeSummarySchema.parse(raw);
    if(value.inventoryId!==input.inventoryId||value.privacyRequestId!==input.privacyRequestId||value.store!==input.store)throw new Error('privacy_response_invalid');
    return value;
  }
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
  if(input.action==='completeDeletion'&&(value.kind!=='deletion'||value.status!=='completed'))throw new Error('privacy_response_invalid');
  if(input.action==='purgeIdentity'){
    const latest=[...value.fulfillment].filter(f=>f.store==='identity').sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)).at(-1);
    if(value.kind!=='deletion'||!latest||!['purged','not_applicable'].includes(latest.outcome)||!latest.evidenceSha256)throw new Error('privacy_response_invalid');
  }
  if(input.action==='recordDisposition'||input.action==='retainByPolicy'){
    const expected=input.action==='recordDisposition'?input.outcome:'retained_by_policy';
    const latest=[...value.fulfillment].filter(f=>f.store===input.store).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)).at(-1);
    if(!latest||latest.outcome!==expected||latest.evidenceSha256!==input.evidenceSha256)throw new Error('privacy_response_invalid');
  }
  if(input.action==='resolveDispute'){
    const r=value.dispute?.resolution;
    if(value.kind!=='dispute'||!r||r.outcome!==input.outcome||r.amendmentSha256!==input.amendmentSha256||r.explanation!==input.explanation)throw new Error('privacy_response_invalid');
  }
  if(input.action==='resolve'){
    const r=value.correction?.resolution;
    if(!r||r.outcome!==input.outcome||r.appliedRevision!==input.appliedRevision||r.explanation!==input.explanation
      ||value.status!==(input.outcome==='applied'?'completed':'refused'))throw new Error('privacy_response_invalid');
  }
  return value;
}
