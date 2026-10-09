import {z} from 'zod';
/** Owner disputes of content the owner cannot correct field by field: a processed lab result, a source lab document,
 * a voice transcript, or a whole personal record. A dispute states what is wrong and what the owner asks for; the
 * operator verifies against the store, records the amendment, annotation or removal evidence (or declines with an
 * explanation), and the outcome is returned in the owner's request ledger. Nothing is changed by the submission. */
export const DISPUTE_STORES=['lab_processing_result','lab_document','voice_transcript','personal_record'] as const;
export const DISPUTE_ACTIONS=['amend','annotate','remove'] as const;
export const DISPUTE_OUTCOMES=['amended','annotated','removed','declined'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const date=z.string().datetime({offset:true});
const referenceId=z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const disputeInputSchema=z.object({
  version:z.literal('personal-dispute/1'),store:z.enum(DISPUTE_STORES),referenceId,contentSha256:hash.nullable(),
  statement:z.string().min(1).max(4000).refine(v=>v.trim().length>0),requestedAction:z.enum(DISPUTE_ACTIONS),
}).strict().refine(v=>v.store==='voice_transcript'?/^[a-f0-9]{64}$/.test(v.referenceId):/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.referenceId),
  'Lab and personal-record references are uuids; voice transcript references are the job digest');
export const disputeTargetSchema=z.object({store:z.enum(DISPUTE_STORES),referenceId,contentSha256:hash.nullable(),requestedAction:z.enum(DISPUTE_ACTIONS),
  statementSha256:hash,requestSha256:hash,statement:z.string().min(1).max(4000).optional()}).strict();
export const disputeResolutionSchema=z.object({outcome:z.enum(DISPUTE_OUTCOMES),amendmentSha256:hash.nullable(),evidenceSha256:hash,
  explanation:z.string().min(1).max(2000),resolvedAt:date}).strict().refine(v=>(v.outcome==='declined')===(v.amendmentSha256===null));
export type DisputeInput=z.infer<typeof disputeInputSchema>;
export type DisputeTarget=z.infer<typeof disputeTargetSchema>;
export type DisputeResolution=z.infer<typeof disputeResolutionSchema>;
