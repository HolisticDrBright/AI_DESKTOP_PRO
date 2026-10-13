if (typeof window !== 'undefined') throw new Error('patient notification ledger is server-only');
import { z } from 'zod';
import { e164, NOTICE_KINDS, patientNotificationPreferences, type NoticeKind, type PatientNotificationPreferences } from '@/contracts/patientNotifications';
import { ClinicalCoreDatabaseRejection, type ClinicalCoreDatabase, type ClinicalCoreTransaction } from '../clinical-core/database';
import type { ClinicalRequestContext } from '../clinical-core/aws-identity-consent';

/**
 * The SQL side of patient notifications, over the BLOCKED candidate
 * infra/aws-clinical-core/source-candidates/patient-notifications.sql. Three narrow interfaces:
 *   - the WORKER ledger (patient_notification_worker): batch, hand out, record, inbound replies and
 *     reminder texts;
 *   - the ENQUEUER, called on the API role after a clinical action has committed;
 *   - the patient's own SETTINGS, on the API role in a verified consumer context.
 * Every reply is parsed to its exact shape; anything else is `service_unavailable`.
 */
export const PATIENT_NOTIFICATIONS_SCHEMA_CANDIDATE_SHA256 = 'e7c88741f955055585d61428ae7edf02ae180a8ccd56ababb6b6e01f1057b91a';
/** The artifacts the candidate was written against, by path under infra/aws-clinical-core/. */
export const PATIENT_NOTIFICATIONS_PARENTS = Object.freeze({
  'migrations/manifest.json': 'f6cf4aa9507c3e61bed4e033dbef74e45acd4461f139abdc11f379ac48d90917',
  'migrations/20260812010000_synthetic_identity_consent.sql': 'c4ca967352bce6c678249336ef410fe7de4216d123a0d3da06a467379780c445',
  'migrations/20260821010000_governed_synthetic_lab_import.sql': 'ed25afdeacfec2bad9722ab1dcff50265a185207f799207c87dc55b19223bb5d',
  'migrations/20260929090000_synthetic_care_messages.sql': '779d879e6058827b46570927ac0de162f8e93d35c326cea59d0d229e4a2b01bd',
  'migrations/20260929120000_synthetic_program_assignments.sql': '8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8',
  'migrations/20260930140000_synthetic_intake_forms_and_signatures.sql': '4cdb7042fc2fd7d83911ad024e9f9f2b07075441ea138f9f447fbfded887b64e',
});

export class PatientNotificationError extends Error {
  constructor(readonly category: 'request_invalid' | 'identity_refused' | 'conflict' | 'service_unavailable') { super(category); this.name = 'PatientNotificationError'; }
}

const uuid = z.string().uuid();
const kinds = z.array(z.enum(NOTICE_KINDS)).min(1).max(NOTICE_KINDS.length);
const reason = z.string().regex(/^[a-z_]{1,48}$/);
const clinicName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .,&'()-]{0,79}$/);

export const dueDelivery = z.object({
  deliveryId: uuid, channel: z.enum(['email', 'sms']), kinds, attempt: z.number().int().min(1).max(3),
  clinicName, consumerSubject: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/), timeZone: z.string().min(3).max(64).nullable(), phone: e164.nullable(),
}).strict().refine(d => d.channel === 'sms' ? d.phone !== null && d.timeZone !== null : d.phone === null, 'delivery_shape');
export type DueDelivery = z.infer<typeof dueDelivery>;
export type DeliveryOutcome =
  | { outcome: 'sent'; providerRef: string }
  | { outcome: 'skipped' | 'failed' | 'retry'; reason: string }
  | { outcome: 'deferred'; reason: string; notBefore: Date };
export const inboundOutcome = z.object({
  outcome: z.enum(['stopped', 'already_stopped', 'help_clinic', 'help_platform', 'resumed', 'consent_required', 'not_stopped', 'ignored']),
  duplicate: z.boolean(),
  clinic: z.object({ displayName: clinicName, helpLine: e164 }).strict().nullable(),
}).strict();
export type InboundOutcome = z.infer<typeof inboundOutcome>;
export const reminderChannels = z.object({
  email: z.boolean(),
  text: z.object({ phone: e164, timeZone: z.string().min(3).max(64), clinicName }).strict().nullable(),
  textReason: reason.nullable(),
}).strict().refine(r => (r.text === null) !== (r.textReason === null), 'reminder_shape');
export type ReminderChannels = z.infer<typeof reminderChannels>;

export interface PatientNotificationWorkerLedger {
  formNotices(windowSeconds: number, limit: number): Promise<{ formed: number }>;
  dueDeliveries(limit: number): Promise<DueDelivery[]>;
  recordDelivery(deliveryId: string, outcome: DeliveryOutcome): Promise<void>;
  recordInbound(phone: string, classification: 'stop' | 'help' | 'start' | 'other', inboundRef: string): Promise<InboundOutcome>;
  reminderChannels(organizationId: string, personId: string): Promise<ReminderChannels>;
  claimReminderText(ref: string, organizationId: string, personId: string, phone: string): Promise<boolean>;
  settleReminderText(ref: string, outcome: { outcome: 'sent'; providerRef: string } | { outcome: 'skipped' | 'failed'; reason: string }): Promise<void>;
}

const json = (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
async function one(tx: ClinicalCoreTransaction, sql: string, parameters: readonly unknown[]) {
  const result = await tx.query<{ r: unknown }>(`select ${sql} as r`, parameters);
  return json(result.rows[0]?.r);
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PatientNotificationError('service_unavailable');
  return result.data;
}
function classify(error: unknown): never {
  if (error instanceof PatientNotificationError) throw error;
  if (error instanceof ClinicalCoreDatabaseRejection) {
    throw new PatientNotificationError(error.category === 'conflict' ? 'conflict' : error.category === 'request_invalid' ? 'request_invalid' : 'identity_refused');
  }
  throw new PatientNotificationError('service_unavailable');
}

/** The worker's ledger. `database` must be a connection whose role is patient_notification_worker. */
export function createSqlPatientNotificationLedger(database: ClinicalCoreDatabase): PatientNotificationWorkerLedger {
  const run = async <T>(work: (tx: ClinicalCoreTransaction) => Promise<T>) => { try { return await database.transaction(work); } catch (error) { return classify(error); } };
  return {
    formNotices: (windowSeconds, limit) => run(async tx => parsed(z.object({ formed: z.number().int().min(0), reason: z.literal('notices_disabled').optional() }).strict(),
      await one(tx, 'clinical_core.form_patient_notices($1,$2)', [windowSeconds, limit]))),
    dueDeliveries: limit => run(async tx => parsed(z.array(dueDelivery).max(limit), await one(tx, 'clinical_core.due_patient_notice_deliveries($1)', [limit]))),
    recordDelivery: (deliveryId, outcome) => run(async tx => {
      await one(tx, 'clinical_core.record_patient_notice_delivery($1,$2,$3,$4,$5)', [deliveryId, outcome.outcome,
        'reason' in outcome ? outcome.reason : null, outcome.outcome === 'deferred' ? outcome.notBefore.toISOString() : null,
        outcome.outcome === 'sent' ? outcome.providerRef : null]);
    }),
    recordInbound: (phone, classification, inboundRef) => run(async tx => parsed(inboundOutcome, await one(tx, 'clinical_core.record_inbound_text($1,$2,$3)', [phone, classification, inboundRef]))),
    reminderChannels: (organizationId, personId) => run(async tx => parsed(reminderChannels, await one(tx, 'clinical_core.patient_reminder_channels($1,$2)', [organizationId, personId]))),
    claimReminderText: (ref, organizationId, personId, phone) => run(async tx => parsed(z.object({ claimed: z.boolean() }).strict(),
      await one(tx, 'clinical_core.claim_patient_reminder_text($1,$2,$3,$4)', [ref, organizationId, personId, phone])).claimed),
    settleReminderText: (ref, outcome) => run(async tx => {
      await one(tx, 'clinical_core.settle_patient_reminder_text($1,$2,$3,$4)', [ref, outcome.outcome, 'reason' in outcome ? outcome.reason : null, outcome.outcome === 'sent' ? outcome.providerRef : null]);
    }),
  };
}

/* -------------------------------------------------------------- enqueue (API role, after commit) */

/** What the server knows when an item becomes visible; the database re-proves it from the item's own table. */
export type NoticeSubject =
  | { kind: 'message'; connectionId: string; messageId: string }
  | { kind: 'form'; connectionId: string; packetId: string }
  | { kind: 'lab_result'; observationId: string }
  | { kind: 'program_lesson'; enrollmentId: string; phaseId?: string }
  | { kind: 'protocol'; connectionId: string; protocolId: string };
export type EnqueueResult = { queued: true; duplicate: boolean } | { queued: false; reason: string };
export type NoticeEnqueuer = (context: ClinicalRequestContext, subject: NoticeSubject) => Promise<EnqueueResult>;
const enqueueResult = z.union([z.object({ queued: z.literal(true), duplicate: z.boolean() }).strict(), z.object({ queued: z.literal(false), reason }).strict()]);

async function withContext(tx: ClinicalCoreTransaction, context: ClinicalRequestContext) {
  await tx.query('select clinical_private.set_request_context($1,$2,$3,$4,$5,$6,$7)', [
    { kind: 'uuid', value: context.actorPersonId }, context.organizationId ? { kind: 'uuid', value: context.organizationId } : null,
    context.identityPool, context.identitySubject, context.purpose, context.environment, context.dataClassification]);
}
export function createSqlNoticeEnqueuer(database: ClinicalCoreDatabase): NoticeEnqueuer {
  return async (context, subject) => {
    const { kind, ...rest } = subject;
    try {
      return await database.transaction(async tx => {
        await withContext(tx, context);
        return parsed(enqueueResult, await one(tx, 'clinical_core.enqueue_patient_notice($1,$2::jsonb)', [kind, JSON.stringify(rest)]));
      });
    } catch (error) { return classify(error); }
  };
}

/* -------------------------------------------------------------- the patient's own settings (API role) */

export const notificationSettingsView = z.object({
  contract: z.literal('patient-notifications/1'),
  preferences: patientNotificationPreferences,
  timeZone: z.string().min(3).max(64).nullable(),
  version: z.number().int().min(0),
  textConsent: z.object({ phone: e164, wordingVersion: z.string(), wordingSha256: z.string().regex(/^[a-f0-9]{64}$/), agreedAt: z.string().datetime({ offset: true }), source: z.literal('patient_app') }).strict().nullable(),
  textStopped: z.boolean(),
  pushAvailable: z.literal(false),
}).strict();
export type NotificationSettingsView = z.infer<typeof notificationSettingsView>;
export const consentWording = z.object({ version: z.string().regex(/^text-consent\/[1-9][0-9]{0,3}$/), body: z.string().min(20).max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function createSqlPatientNotificationSettings(database: ClinicalCoreDatabase) {
  const run = async <T>(context: ClinicalRequestContext, work: (tx: ClinicalCoreTransaction) => Promise<T>) => {
    if (context.identityPool !== 'consumer') throw new PatientNotificationError('identity_refused');
    try { return await database.transaction(async tx => { await withContext(tx, context); return work(tx); }); } catch (error) { return classify(error); }
  };
  return {
    read: (context: ClinicalRequestContext) => run(context, async tx => parsed(notificationSettingsView, await one(tx, 'clinical_core.my_patient_notification_settings()', []))),
    wording: (context: ClinicalRequestContext) => run(context, async tx => parsed(consentWording.nullable(), await one(tx, 'clinical_core.current_text_consent_wording()', []))),
    save: (context: ClinicalRequestContext, preferences: PatientNotificationPreferences, timeZone: string | null, expectedVersion: number) => run(context, async tx =>
      parsed(notificationSettingsView, await one(tx, 'clinical_core.set_my_patient_notification_settings($1::jsonb,$2,$3)', [JSON.stringify(patientNotificationPreferences.parse(preferences)), timeZone, expectedVersion]))),
    consent: (context: ClinicalRequestContext, phone: string, wordingVersion: string, wordingSha256: string) => run(context, async tx =>
      parsed(notificationSettingsView, await one(tx, 'clinical_core.record_my_text_consent($1,$2,$3)', [phone, wordingVersion, wordingSha256]))),
    withdraw: (context: ClinicalRequestContext) => run(context, async tx => parsed(notificationSettingsView, await one(tx, 'clinical_core.withdraw_my_text_consent()', []))),
  };
}
export type { NoticeKind };
