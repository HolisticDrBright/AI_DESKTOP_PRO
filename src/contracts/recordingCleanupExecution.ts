import {z} from 'zod';
import {cleanupOutcomeSchema} from './recordingCleanupReview';
const uuid=z.string().uuid();
/** The operator supplies only the exact reviewed item and an idempotency key.
 * Worker/release/organization/authority are never client-selected. */
export const cleanupExecutionRequestSchema=z.object({
  recordingId:uuid,version:z.number().int().positive().safe(),requestId:uuid,
  confirmation:z.literal('run_bounded_cleanup_pass'),
}).strict();
export const cleanupExecutionReceiptSchema=z.union([
  z.object({state:z.literal('already_claimed'),runId:uuid,recordingId:uuid,
    audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict(),
  z.object({runId:uuid,recordingId:uuid,outcome:cleanupOutcomeSchema,appliedToSchedule:z.boolean(),
    nextCheckAt:z.string().datetime({offset:true}).nullable(),audioDeleted:z.literal(false),requiresRecheck:z.literal(true)}).strict(),
]);
