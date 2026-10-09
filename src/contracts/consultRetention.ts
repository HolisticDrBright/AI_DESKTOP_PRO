import { z } from 'zod';

/**
 * Erasing the contact details of someone who asked about care and never became a patient.
 *
 * Three rules live in these shapes and no screen may soften any of them.
 *
 * A refusal is a value, not an error. "Not yet, and here is why" is something a practitioner
 * can act on, and a refusal that arrived as a failure would be retried instead of read.
 *
 * `purgeContactAfterDays` is nullable and there is no default anywhere in this file. How long a
 * clinic keeps an enquiry is its own compliance posture; a number invented here would quietly
 * become that posture. `automaticPurge` says plainly which state the practice is in.
 *
 * There is no consumer request shape at all. An enquirer has no account, and an unauthenticated
 * erase-by-contact endpoint would be a way to ask a clinic which addresses had written to it.
 */
export const CONSULT_RETENTION_ACK = 'consult-retention/1' as const;
const uuid = z.string().uuid();
export const consultPurgeRefusal = z.enum(['already_purged', 'converted_to_a_patient_record',
  'still_open_and_no_retention_window_is_set', 'still_open_and_inside_the_retention_window']);
export type ConsultPurgeRefusal = z.infer<typeof consultPurgeRefusal>;
const days = z.number().int().min(1).max(3650);

export const consultRetentionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings_read') }).strict(),
  // Null is a choice — keep enquiries until somebody purges them by hand — so the field is
  // required and nullable rather than optional. Omitting it is not the same as setting it.
  z.object({ action: z.literal('settings_set'), purgeContactAfterDays: days.nullable() }).strict(),
  z.object({ action: z.literal('pending') }).strict(),
  z.object({ action: z.literal('purge'), requestId: uuid }).strict(),
  z.object({ action: z.literal('sweep') }).strict(),
]);
export type ConsultRetentionRequest = z.infer<typeof consultRetentionRequest>;

const settings = {
  purgeContactAfterDays: days.nullable(),
  automaticPurge: z.boolean(),
};
export const consultRetentionResponse = z.union([
  z.object({ action: z.literal('settings_read'), ...settings,
    version: z.number().int().positive().nullable() }).strict(),
  z.object({ action: z.literal('settings_set'), ...settings,
    version: z.number().int().positive() }).strict(),
  z.object({
    action: z.literal('pending'), purgeContactAfterDays: days.nullable(),
    purgeable: z.number().int().min(0), stillHeld: z.number().int().min(0),
    alreadyPurged: z.number().int().min(0),
  }).strict(),
  z.object({
    action: z.literal('purge'), requestId: uuid, purged: z.boolean(),
    refusal: consultPurgeRefusal.nullable(),
  }).strict(),
  z.object({
    action: z.literal('sweep'), purged: z.number().int().min(0),
    skipped: z.literal('no_retention_window_is_set').nullable(),
  }).strict(),
]);
export type ConsultRetentionResponse = z.infer<typeof consultRetentionResponse>;

export const parseConsultRetentionResponse = (request: ConsultRetentionRequest, raw: unknown) => {
  const parsed = consultRetentionResponse.parse(raw);
  if (parsed.action !== request.action) throw new Error('response_action_mismatch');
  return parsed;
};

/** Why a purge was refused, in words a practitioner can act on. */
export const PURGE_REFUSAL_LABEL: Record<ConsultPurgeRefusal, string> = {
  already_purged: 'These details were already erased.',
  converted_to_a_patient_record:
    'This person became a patient, so their own erasure request reaches this — it is not erased here.',
  still_open_and_no_retention_window_is_set:
    'You have not answered this one yet. Decline or accept it first, or set a retention window.',
  still_open_and_inside_the_retention_window:
    'You have not answered this one yet, and it is still inside your retention window.',
};
