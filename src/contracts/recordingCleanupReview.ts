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
