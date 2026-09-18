import {z} from 'zod';
const uuid=z.string().uuid(),date=z.string().datetime({offset:true});
export const cleanupOutcomeSchema=z.enum(['empty_observed','needs_recheck','held','unavailable','refused']);
export const cleanupWorkItemSchema=z.object({recordingId:uuid,patientRecordId:uuid,version:z.number().int().positive().safe(),
  reason:z.enum(['retention_deadline','discard','consent_revoked']),dueAt:date,nextCheckAt:date,leaseUntil:date.nullable(),
  lastOutcome:cleanupOutcomeSchema.nullable(),consecutiveFailures:z.number().int().min(0).max(16),unresolvedAttempts:z.number().int().nonnegative(),
  audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict();
export const cleanupWorkPageSchema=z.object({items:z.array(cleanupWorkItemSchema).max(25),nextAfter:uuid.nullable()}).strict();
export const cleanupHistoryItemSchema=z.object({runId:uuid,version:z.number().int().positive().safe(),claimedAt:date,leaseUntil:date,
  leaseActive:z.boolean(),result:z.object({outcome:cleanupOutcomeSchema,deleteAcknowledged:z.number().int().min(0).max(25).nullable(),
    recordedAt:date,appliedToSchedule:z.boolean(),nextCheckAt:date.nullable()}).strict().nullable(),
  audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict();
export const cleanupHistoryPageSchema=z.object({recordingId:uuid,runs:z.array(cleanupHistoryItemSchema).max(25),nextAfter:uuid.nullable()}).strict();
export const cleanupReviewRequestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('queue'),after:uuid.optional()}).strict(),
  z.object({action:z.literal('history'),recordingId:uuid,after:uuid.optional()}).strict(),
]);
export type CleanupReviewRequest=z.infer<typeof cleanupReviewRequestSchema>;
export type CleanupWorkPage=z.infer<typeof cleanupWorkPageSchema>;
export type CleanupHistoryPage=z.infer<typeof cleanupHistoryPageSchema>;
const envelopeSchema=z.object({data:z.unknown(),capabilities:z.object({review:z.literal(true),dispatch:z.literal(false),storageDeletion:z.literal(false)}).strict()}).strict();
export function parseCleanupReviewResponse(request:CleanupReviewRequest,value:unknown){
  const envelope=envelopeSchema.parse(value);
  const data=request.action==='queue'?cleanupWorkPageSchema.parse(envelope.data):cleanupHistoryPageSchema.parse(envelope.data);
  if('recordingId' in data&&(request.action!=='history'||data.recordingId!==request.recordingId))throw new Error('cleanup_review_scope_mismatch');
  const ids='items' in data?data.items.map(i=>i.recordingId):data.runs.map(r=>r.runId);
  if(ids.some((id,i)=>i>0&&id<=ids[i-1]||request.after!==undefined&&id<=request.after)
    ||data.nextAfter!==(ids.length===25?ids.at(-1):null))throw new Error('cleanup_review_page_invalid');
  return {data,capabilities:envelope.capabilities};
}
